'use strict';

const pathModule = require('path');
const { PassThrough } = require('stream');

// Production base URL of the Esendex Messaging API (https://developer.esendex.co.uk,
// Home -> Getting started -> Base URL). Connected accounts may override it (regional
// domains or the Esendex test environment) via the optional "Base URL" auth field.
const DEFAULT_BASE_URL = 'https://api.esendex.co.uk';

// Value of the X-External-Source header (CO-4491). The API gateway matches it
// case-insensitively against its allow-list and forwards it as the request source
// downstream; an unknown value is downgraded to "API", never rejected.
const EXTERNAL_SOURCE = 'Appmixer';

// Prefix of CSV files produced by the 'file' output type of Find/List components.
const DEFAULT_PREFIX = 'esendex-objects-export';

// --- Large-volume pagination constants (CO-3783, Appmixer guidance 2026-08-18) ---

// Documented maximum page size of the Esendex v2 list endpoints.
const PAGE_SIZE = 1000;

// The engine rejects messages over its size limit. Designed against the announced
// future limit (2 MB, per Appmixer) rather than today's ~15 MB; a tenant can widen
// it via the `messageLimitBytes` component config until the platform change lands.
const DEFAULT_MESSAGE_LIMIT_BYTES = 2 * 1024 * 1024;
// Stop accumulating at ~70% of the message limit (leaves room for the envelope).
const SIZE_BUDGET_RATIO = 0.7;

// Execution-time budget of one receive() invocation for 'array'/'first'/'object'
// runs ('object' continues in a new invocation; 'array' fails with a clear error).
const DEFAULT_FIND_DEADLINE_MS = 30 * 1000;
// CSV exports stream page by page and get a larger single-run budget.
const DEFAULT_FILE_DEADLINE_MS = 180 * 1000;

// 429 handling inside the pagination loop - the quota manager counts the whole
// receive() as one call, so rate limits must be handled here.
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_MS = 30 * 1000;

// Delay before a timeout continuation resumes an 'object' export.
const RESUME_DELAY_MS = 1000;

module.exports = {

    DEFAULT_BASE_URL,
    EXTERNAL_SOURCE,
    PAGE_SIZE,

    // Resolve the API base URL for a connected account. Accepts the object that
    // holds the auth fields: `context.auth` inside components, or the auth
    // `context` itself inside auth.js (where fields live at the top level).
    getBaseUrl(auth = {}) {

        return (auth.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    },

    // Add the X-External-Source header to a request's headers, so the gateway
    // attributes the call to this integration. Set last: callers cannot override it.
    withExternalSource(headers = {}) {

        return { ...headers, 'X-External-Source': EXTERNAL_SOURCE };
    },

    // Split a textarea/multiselect value (newline / comma / semicolon separated)
    // into a trimmed list.
    toList(value) {

        if (Array.isArray(value)) {
            return value.map(v => String(v).trim()).filter(Boolean);
        }
        if (typeof value === 'string') {
            return value.split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
        }
        return [];
    },

    // Accept either an already-parsed object or a JSON string (free-form JSON
    // inputs such as metaData).
    parseObject(context, value, label) {

        if (!value) {
            return undefined;
        }
        if (typeof value === 'object') {
            return value;
        }
        try {
            return JSON.parse(value);
        } catch (err) {
            throw new context.CancelError(`"${label}" must be valid JSON (${err.message}).`);
        }
    },

    // Convert an HTTP error into the right kind of error for the engine
    // (CO-3911). Permanent client errors (4xx except 408/429) become
    // context.CancelError so the run fails fast instead of being auto-retried
    // forever; transient failures (408/429, 5xx, network) stay regular errors
    // so the engine's automatic retry can help. The structured Esendex error
    // list ({ errors: [{ errorCode, errorMessage }] }) is used for the message
    // when present.
    toApiError(context, err) {

        const status = err && err.response && err.response.status;
        const apiErrors = err && err.response && err.response.data && err.response.data.errors;
        const hasApiErrors = Array.isArray(apiErrors) && apiErrors.length;
        const message = hasApiErrors
            ? 'Esendex API error: ' + apiErrors.map(e => `${e.errorCode}: ${e.errorMessage}`).join('; ')
            : (err && err.message) || 'Esendex API error';

        const isPermanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (isPermanent) {
            return new context.CancelError(message);
        }
        if (hasApiErrors) {
            return new Error(message);
        }
        return err;
    },

    // context.httpRequest with 429/Retry-After backoff. The quota manager counts
    // the whole receive() as one call, so rate limiting inside a pagination loop
    // must be handled here, per request.
    async requestWithRetry(context, options) {

        let attempt = 0;
        for (;;) {
            try {
                return await context.httpRequest(options);
            } catch (err) {
                const status = err && err.response && err.response.status;
                if (status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) {
                    throw err;
                }
                const headers = (err.response && err.response.headers) || {};
                const retryAfter = headers['retry-after'];
                const waitMs = /^\d+$/.test(String(retryAfter))
                    ? Math.min(parseInt(retryAfter, 10) * 1000, MAX_RATE_LIMIT_WAIT_MS)
                    : Math.min(Math.pow(2, attempt) * 1000, MAX_RATE_LIMIT_WAIT_MS);
                await context.log({
                    step: 'Rate limited (429), retrying', attempt: attempt + 1, waitMs
                });
                await new Promise(resolve => setTimeout(resolve, waitMs));
                attempt += 1;
            }
        }
    },

    // Run a paginated Find against one Esendex v2 list endpoint and deliver the
    // result in the selected output type. Implements the Appmixer large-volume
    // pattern (CO-3783): the page loop stops on end-of-data, a serialized-size
    // budget, or an execution-time deadline - never on a record-count cap - and
    // the stop reason is always logged.
    //
    //  - array: accumulates within the size budget; exceeding any limit fails
    //    with a clear error instead of truncating.
    //  - first: fetches pages only until the first record.
    //  - object: emits items page by page and checkpoints the cursor in state;
    //    on deadline it schedules a timeout continuation and resumes until every
    //    record is emitted (route context.messages.timeout to resumePaginatedFind).
    //  - file: streams CSV rows to saveFileStream page by page (nothing large is
    //    held in memory or sent through the flow - only { fileId }).
    //
    // options: { context, outputType, endpointPath, itemsKey, label,
    //            filterParams, pageParamCase: 'camel'|'pascal' }
    async runPaginatedFind(options) {

        const { context, outputType = 'array' } = options;

        if (outputType === 'object') {
            // Crash redelivery of the same `in` message keeps context.id, so a
            // previously stored cursor resumes instead of re-emitting everything.
            const state = await context.stateGet(context.id);
            return runObjectExport(options, {
                stateId: context.id,
                startPage: (state && state.nextPage) || 1,
                emitted: (state && state.emitted) || 0
            });
        }
        if (outputType === 'file') {
            return runFileExport(options);
        }
        return runAccumulatedFind(options);
    },

    // Timeout-continuation entry point for resumable 'object' exports. Components
    // route context.messages.timeout here with the same static options they pass
    // to runPaginatedFind. Filters and the cursor come from the stored state.
    async resumePaginatedFind(options) {

        const { context } = options;
        const stateId = context.messages.timeout.content.stateId;
        const state = await context.stateGet(stateId);
        if (!state) {
            // Flow stopped/finished between the schedule and this delivery.
            return context.log({ step: 'Resume skipped', message: 'No stored cursor - nothing to do.' });
        }
        return runObjectExport({ ...options, outputType: 'object', filterParams: state.filterParams }, {
            stateId,
            startPage: state.nextPage,
            emitted: state.emitted
        });
    },

    // Standardized output helper for components with an `outputType` input whose
    // result set is small and already in memory (single-page Finds like
    // FindTemplates). Large-volume components use runPaginatedFind instead.
    async sendArrayOutput({
        context,
        outputPortName = 'out',
        outputType = 'array',
        records = []
    }) {
        if (outputType === 'first') {
            if (records.length === 0) {
                throw new context.CancelError('No records available for first output type');
            }
            await context.sendJson(
                { ...records[0], index: 0, count: records.length },
                outputPortName
            );
        } else if (outputType === 'object') {
            for (let index = 0; index < records.length; index++) {
                await context.sendJson(
                    { ...records[index], index, count: records.length },
                    outputPortName
                );
            }
        } else if (outputType === 'array') {
            await context.sendJson({ result: records, count: records.length }, outputPortName);
        } else if (outputType === 'file') {
            const csvString = [
                Object.keys(records[0]).map(escapeCsv).join(','),
                ...records.map(row => Object.keys(records[0]).map(header => escapeCsv(row[header])).join(','))
            ].join('\n');
            const buffer = Buffer.from(csvString, 'utf8');
            const savedFile = await context.saveFileStream(pathModule.normalize(csvFileName(context)), buffer);
            await context.log({ step: 'File was saved', fileName: csvFileName(context), fileId: savedFile.fileId });
            await context.sendJson({ fileId: savedFile.fileId }, outputPortName);
        } else {
            throw new context.CancelError('Unsupported outputType ' + outputType);
        }
    },

    // Generate the dynamic output port options for the selected output type.
    // Called by the Designer through the out port `source` block when
    // `generateOutputPortOptions` is set - see FindMessages/component.json.
    getOutputPortOptions(context, outputType, itemSchema, { label, value }) {

        if (outputType === 'object' || outputType === 'first') {
            const options = Object.keys(itemSchema)
                .reduce((res, field) => {
                    const schema = itemSchema[field];
                    const { title: optionLabel, ...schemaWithoutTitle } = schema;
                    res.push({ label: optionLabel, value: field, schema: schemaWithoutTitle });
                    return res;
                }, [{
                    label: 'Current Item Index',
                    value: 'index',
                    schema: { type: 'integer' }
                }, {
                    label: 'Items Count',
                    value: 'count',
                    schema: { type: 'integer' }
                }]);
            return context.sendJson(options, 'out');
        }

        if (outputType === 'array') {
            return context.sendJson([{
                label,
                value,
                schema: {
                    type: 'array',
                    items: { type: 'object', properties: itemSchema }
                }
            }], 'out');
        }

        if (outputType === 'file') {
            return context.sendJson([{ label: 'File ID', value: 'fileId' }], 'out');
        }
    }
};

// --- Internal pagination engine -------------------------------------------------

const lib = module.exports;

const sizeBudgetBytes = (context) => {

    const limit = parseInt(context.config && context.config.messageLimitBytes, 10) || DEFAULT_MESSAGE_LIMIT_BYTES;
    return Math.floor(limit * SIZE_BUDGET_RATIO);
};

const findDeadlineMs = (context) =>
    parseInt(context.config && context.config.findDeadlineMs, 10) || DEFAULT_FIND_DEADLINE_MS;

const fileDeadlineMs = (context) =>
    parseInt(context.config && context.config.fileExportDeadlineMs, 10) || DEFAULT_FILE_DEADLINE_MS;

const csvFileName = (context) => {

    const componentName =
        (context.flowDescriptor && context.flowDescriptor[context.componentId] &&
            context.flowDescriptor[context.componentId].label) || context.componentId;
    return `${(context.config && context.config.outputFilePrefix) || DEFAULT_PREFIX}-${componentName}.csv`;
};

// Build a fetchPage(pageNo) closure for one endpoint. Returns the page's records
// plus the totals the API reports alongside them.
const makeFetchPage = ({ context, endpointPath, itemsKey, filterParams, pageParamCase }) => {

    const url = `${lib.getBaseUrl(context.auth)}${endpointPath}`;
    const headers = {
        'X-Api-Key': context.auth.apiKey,
        'AccountReference': context.auth.accountReference
    };

    return async (pageNo) => {
        const pageParams = pageParamCase === 'pascal'
            ? { PageSize: PAGE_SIZE, PageNo: pageNo }
            : { pageSize: PAGE_SIZE, pageNo };
        const response = await lib.requestWithRetry(context, {
            method: 'GET',
            url,
            headers,
            params: { ...filterParams, ...pageParams }
        });
        const data = (response.data && response.data.data) || {};
        return {
            records: data[itemsKey] || [],
            totalPages: data.totalPages || 1,
            totalCount: typeof data.totalCount === 'number' ? data.totalCount : undefined
        };
    };
};

// The shared page loop with the three stop conditions from the Appmixer guidance:
// end-of-data, serialized-size budget, execution-time deadline. Which one fired is
// returned as stopReason ('end-of-data' | 'size-limit' | 'time-limit' | 'first-record')
// and must be logged by the caller when it implies an incomplete result.
const paginate = async ({
    fetchPage, onPage, startPage = 1, budgetBytes = Infinity, deadlineAt = Infinity, stopAtFirstRecord = false
}) => {

    let pageNo = startPage;
    let totalPages = 1;
    let totalCount;
    let bytes = 0;
    let records = 0;

    do {
        const page = await fetchPage(pageNo);
        totalPages = page.totalPages;
        totalCount = page.totalCount !== undefined ? page.totalCount : totalCount;

        if (page.records.length) {
            bytes += Buffer.byteLength(JSON.stringify(page.records), 'utf8');
            await onPage(page.records, pageNo, totalCount);
            records += page.records.length;
            if (stopAtFirstRecord) {
                return { stopReason: 'first-record', nextPage: pageNo + 1, totalPages, totalCount, records };
            }
        }
        pageNo += 1;

        // The size budget guards the outgoing message, so it applies even when
        // this was the last page; the deadline only matters while pages remain.
        if (bytes >= budgetBytes) {
            return { stopReason: 'size-limit', nextPage: pageNo, totalPages, totalCount, records };
        }
        if (pageNo <= totalPages && Date.now() >= deadlineAt) {
            return { stopReason: 'time-limit', nextPage: pageNo, totalPages, totalCount, records };
        }
    } while (pageNo <= totalPages);

    return { stopReason: 'end-of-data', nextPage: pageNo, totalPages, totalCount, records };
};

// 'array' and 'first' output types: accumulate in memory within the byte budget.
// An 'array' result that hits a limit fails with a clear error - no silent truncation.
const runAccumulatedFind = async (options) => {

    const { context, outputType, label } = options;
    const fetchPage = makeFetchPage(options);
    const accumulated = [];

    let outcome;
    try {
        outcome = await paginate({
            fetchPage,
            onPage: async (records) => { accumulated.push(...records); },
            budgetBytes: sizeBudgetBytes(context),
            deadlineAt: Date.now() + findDeadlineMs(context),
            stopAtFirstRecord: outputType === 'first'
        });
    } catch (err) {
        throw lib.toApiError(context, err);
    }

    if (!accumulated.length) {
        return context.sendJson({}, 'notFound');
    }

    if (outputType === 'first') {
        const count = outcome.totalCount !== undefined ? outcome.totalCount : accumulated.length;
        return context.sendJson({ ...accumulated[0], index: 0, count }, 'out');
    }

    if (outcome.stopReason !== 'end-of-data') {
        // The oversized-output guard: a clear error beats a partial array.
        await context.log({
            step: 'Array output aborted', stopReason: outcome.stopReason,
            fetchedPages: outcome.nextPage - 1, totalPages: outcome.totalPages
        });
        const limit = outcome.stopReason === 'size-limit' ? 'message size budget' : 'execution time budget';
        throw new context.CancelError(
            `Too many ${label} for the 'All items at once' output (${limit} exceeded ` +
            `after ${accumulated.length} records). Use 'Store to CSV file' or ` +
            '\'One item at a time\', or narrow the filters.'
        );
    }

    return context.sendJson({ result: accumulated, count: accumulated.length }, 'out');
};

// 'file' output type: stream CSV rows page by page - only { fileId } travels
// through the flow, and no full record set is ever held in memory.
const runFileExport = async (options) => {

    const { context, label } = options;
    const fetchPage = makeFetchPage(options);
    const fileName = pathModule.normalize(csvFileName(context));

    let stream = null;
    let savePromise = null;
    let buffered = null;
    let headerKeys = null;

    const writeLine = (line) => {
        if (buffered) {
            buffered.push(line);
        } else {
            stream.write(line);
        }
    };

    let outcome;
    try {
        outcome = await paginate({
            fetchPage,
            onPage: async (records) => {
                if (!headerKeys) {
                    // Lazy start: no file at all when the result set is empty.
                    headerKeys = Object.keys(records[0]);
                    stream = new PassThrough();
                    savePromise = context.saveFileStream(fileName, stream);
                    // The engine's promise settles only when the stream ends; the
                    // CLI sandbox (buffers only) rejects instantly. Probe briefly
                    // and fall back to a buffered save in the sandbox.
                    const probe = await Promise.race([
                        savePromise.then(() => null, err => err),
                        new Promise(resolve => setTimeout(() => resolve(null), 50))
                    ]);
                    if (probe) {
                        if (probe.code !== 'ERR_INVALID_ARG_TYPE') {
                            throw probe;
                        }
                        stream = null;
                        savePromise = null;
                        buffered = [];
                    }
                    writeLine(headerKeys.map(escapeCsv).join(',') + '\n');
                }
                for (const row of records) {
                    writeLine(headerKeys.map(key => escapeCsv(row[key])).join(',') + '\n');
                }
            },
            deadlineAt: Date.now() + fileDeadlineMs(context)
        });
    } catch (err) {
        if (stream) {
            stream.destroy(err);
        }
        throw lib.toApiError(context, err);
    }

    if (!headerKeys) {
        return context.sendJson({}, 'notFound');
    }

    let savedFile;
    if (buffered) {
        savedFile = await context.saveFileStream(fileName, Buffer.from(buffered.join(''), 'utf8'));
    } else {
        stream.end();
        savedFile = await savePromise;
    }

    if (outcome.stopReason !== 'end-of-data') {
        await context.log({
            step: 'Export truncated (time limit)', stopReason: outcome.stopReason,
            exportedRecords: outcome.records, fetchedPages: outcome.nextPage - 1,
            totalPages: outcome.totalPages,
            message: `The CSV contains the first ${outcome.records} ${label}; raise the ` +
                'fileExportDeadlineMs component config or narrow the filters for a complete export.'
        });
    }
    await context.log({
        step: 'File was saved', fileName, fileId: savedFile.fileId, records: outcome.records
    });
    return context.sendJson({ fileId: savedFile.fileId }, 'out');
};

// 'object' output type: emit items page by page with a checkpoint after every
// page (canonical pattern: utils/controls/Each). On deadline, schedule a timeout
// continuation and resume from the stored cursor - unlimited, resumable export.
// Delivery is at-least-once around a crash: the last checkpointed page may be
// re-emitted.
const runObjectExport = async (options, { stateId, startPage, emitted }) => {

    const { context, label, filterParams } = options;
    const fetchPage = makeFetchPage(options);
    let emittedSoFar = emitted;

    let outcome;
    try {
        outcome = await paginate({
            fetchPage,
            startPage,
            onPage: async (records, pageNo, totalCount) => {
                for (const record of records) {
                    await context.sendJson(
                        { ...record, index: emittedSoFar, count: totalCount !== undefined ? totalCount : null },
                        'out'
                    );
                    emittedSoFar += 1;
                }
                await context.stateSet(stateId, {
                    nextPage: pageNo + 1,
                    emitted: emittedSoFar,
                    filterParams
                });
            },
            deadlineAt: Date.now() + findDeadlineMs(context)
        });
    } catch (err) {
        throw lib.toApiError(context, err);
    }

    if (outcome.stopReason === 'time-limit') {
        if (typeof context.setTimeout === 'function') {
            await context.log({
                step: 'Export continues in a new run', emitted: emittedSoFar,
                nextPage: outcome.nextPage, totalPages: outcome.totalPages
            });
            return context.setTimeout({ stateId }, RESUME_DELAY_MS);
        }
        // Engine without timeout scheduling: log and finish the loop in this run.
        await context.log({
            step: 'Deadline exceeded but timeout continuations are unavailable - finishing in this run',
            emitted: emittedSoFar
        });
        return runObjectExport(options, { stateId, startPage: outcome.nextPage, emitted: emittedSoFar });
    }

    await context.stateUnset(stateId);

    if (!emittedSoFar) {
        return context.sendJson({}, 'notFound');
    }
    await context.log({ step: 'Export finished', emitted: emittedSoFar, label });
};

// Escape a value for CSV: objects -> JSON, then wrap in double
// quotes and double any inner quote when the value contains , " or a newline.
const escapeCsv = (value) => {

    if (value === null || value === undefined) {
        return '';
    }
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
};
