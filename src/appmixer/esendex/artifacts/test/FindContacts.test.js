'use strict';

const assert = require('assert');

const FindContacts = require('../../core/FindContacts/FindContacts.js');

const CONTACT = {
    contactId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    firstName: 'Ada',
    lastName: 'Lovelace',
    smsoptOutStatus: 'Subscribed', // lower-case 'o' matches the API, not a typo
    addresses: [{ addressType: 'Mobile', addressValue: '+447700900123' }],
    contactMetadata: { crmId: '42' }
};

function createContext({
    content = {}, properties = {}, contactsData = [CONTACT], pages, httpError, config = {}, rateLimitFirstCall
} = {}) {

    const context = {
        auth: {
            apiKey: 'test-api-key',
            accountReference: 'EXUK0000000'
        },
        properties,
        config,
        id: 'run-1',
        componentId: 'find-contacts',
        flowDescriptor: { 'find-contacts': { label: 'FindContacts' } },
        messages: { in: { content } },
        CancelError: class CancelError extends Error {
            constructor(message) {
                super(message);
                this.name = 'CancelError';
            }
        },
        sent: [],
        requests: [],
        logs: [],
        files: [],
        timeouts: [],
        state: {},
        log: async entry => { context.logs.push(entry); },
        stateGet: async key => (key in context.state ? context.state[key] : null),
        stateSet: async (key, value) => { context.state[key] = value; },
        stateUnset: async key => { delete context.state[key]; },
        setTimeout: async (payload, delay) => { context.timeouts.push({ payload, delay }); },
        saveFileStream: async (fileName, stream) => {
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            context.files.push({ fileName, contents: Buffer.concat(chunks).toString('utf8') });
            return { fileId: 'file-1' };
        },
        httpRequest: async options => {
            context.requests.push(options);
            if (rateLimitFirstCall && context.requests.length === 1) {
                const rateErr = new Error('Request failed with status code 429');
                rateErr.response = { status: 429, headers: { 'retry-after': '0' } };
                throw rateErr;
            }
            if (httpError) {
                throw httpError;
            }
            if (pages) {
                const pageNo = options.params.pageNo || 1;
                return { data: { data: { contacts: pages[pageNo - 1] || [], totalPages: pages.length } } };
            }
            return { data: { data: { contacts: contactsData, totalCount: contactsData.length } } };
        },
        sendJson: (data, port) => {
            context.sent.push({ data, port });
            return Promise.resolve();
        }
    };
    return context;
}

describe('Esendex FindContacts', function() {

    it('generates output port options without calling the API (array mode)', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            properties: { generateOutputPortOptions: true }
        });

        await FindContacts.receive(context);

        assert.strictEqual(context.requests.length, 0);
        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data[0].value, 'result');
        assert.strictEqual(context.sent[0].data[0].schema.type, 'array');
    });

    it('queries /v2/contacts/filter with auth headers and only the provided filters', async function() {

        const context = createContext({
            content: { outputType: 'array', search: 'Ada', optOutStatus: 'subscribed' }
        });

        await FindContacts.receive(context);

        const request = context.requests[0];
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/contacts/filter');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.strictEqual(request.headers['AccountReference'], 'EXUK0000000');
        assert.deepStrictEqual(request.params, {
            search: 'Ada',
            optOutStatus: 'subscribed',
            pageSize: 1000,
            pageNo: 1
        });
        assert.deepStrictEqual(context.sent[0].data, { result: [CONTACT], count: 1 });
    });

    it('sends to the notFound port when no contact matches', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            contactsData: []
        });

        await FindContacts.receive(context);

        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.sent[0].port, 'notFound');
        assert.deepStrictEqual(context.sent[0].data, {});
    });

    it('surfaces the structured Esendex error list on API failures', async function() {

        const httpError = new Error('Request failed with status code 401');
        httpError.response = {
            data: {
                errors: [{ errorCode: 'unauthenticatedError', errorMessage: 'Request was unauthenticated' }]
            }
        };

        const context = createContext({
            content: { outputType: 'array' },
            httpError
        });

        await assert.rejects(
            () => FindContacts.receive(context),
            err => /unauthenticatedError: Request was unauthenticated/.test(err.message)
        );
    });

    it('follows pagination and returns contacts from every page', async function() {

        const secondContact = { ...CONTACT, contactId: 'second' };
        const context = createContext({
            content: { outputType: 'array' },
            pages: [[CONTACT], [secondContact]]
        });

        await FindContacts.receive(context);

        assert.strictEqual(context.requests.length, 2);
        assert.strictEqual(context.requests[0].params.pageNo, 1);
        assert.strictEqual(context.requests[1].params.pageNo, 2);
        assert.deepStrictEqual(context.sent[0].data, { result: [CONTACT, secondContact], count: 2 });
    });

    it('rejects array output when the result exceeds the message size budget', async function() {

        // 100-byte message limit -> 70-byte budget; a single real contact exceeds it.
        const context = createContext({
            content: { outputType: 'array' },
            config: { messageLimitBytes: '100' }
        });

        await assert.rejects(
            () => FindContacts.receive(context),
            err => err.name === 'CancelError' && /Too many contacts/.test(err.message)
        );
        assert.strictEqual(context.logs[0].step, 'Array output aborted');
        assert.strictEqual(context.logs[0].stopReason, 'size-limit');
    });

    it('retries with backoff when the API rate-limits a page (429)', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            rateLimitFirstCall: true
        });

        await FindContacts.receive(context);

        assert.strictEqual(context.requests.length, 2);
        assert.strictEqual(context.logs[0].step, 'Rate limited (429), retrying');
        assert.deepStrictEqual(context.sent[0].data, { result: [CONTACT], count: 1 });
    });

    it('streams a CSV file page by page in file mode', async function() {

        const secondContact = { ...CONTACT, contactId: 'second' };
        const context = createContext({
            content: { outputType: 'file' },
            pages: [[CONTACT], [secondContact]]
        });

        await FindContacts.receive(context);

        assert.strictEqual(context.files.length, 1);
        const lines = context.files[0].contents.trim().split('\n');
        assert.strictEqual(lines.length, 3); // header + one row per contact
        assert.ok(lines[0].startsWith('contactId,'));
        assert.deepStrictEqual(context.sent[0].data, { fileId: 'file-1' });
    });

    it('emits items page by page with a checkpoint in object mode', async function() {

        const secondContact = { ...CONTACT, contactId: 'second' };
        const context = createContext({
            content: { outputType: 'object' },
            pages: [[CONTACT], [secondContact]]
        });

        await FindContacts.receive(context);

        assert.strictEqual(context.sent.length, 2);
        assert.strictEqual(context.sent[0].data.index, 0);
        assert.strictEqual(context.sent[1].data.index, 1);
        assert.strictEqual(context.sent[1].data.contactId, 'second');
        // Checkpoint cleaned up after a completed export.
        assert.deepStrictEqual(context.state, {});
    });

    it('pauses object mode at the deadline and resumes from the checkpoint via timeout', async function() {

        const secondContact = { ...CONTACT, contactId: 'second' };
        const context = createContext({
            content: { outputType: 'object', search: 'Ada' },
            pages: [[CONTACT], [secondContact]],
            // A deadline in the past: the loop pauses after the first page.
            config: { findDeadlineMs: '-1000' }
        });

        await FindContacts.receive(context);

        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.timeouts.length, 1);
        assert.deepStrictEqual(context.timeouts[0].payload, { stateId: 'run-1' });
        assert.deepStrictEqual(context.state['run-1'], {
            nextPage: 2, emitted: 1, filterParams: { search: 'Ada' }
        });

        // Deliver the scheduled timeout: the export resumes and completes.
        context.config = {};
        context.messages = { timeout: { content: { stateId: 'run-1' } } };
        await FindContacts.receive(context);

        assert.strictEqual(context.sent.length, 2);
        assert.strictEqual(context.sent[1].data.contactId, 'second');
        assert.strictEqual(context.sent[1].data.index, 1);
        // The resumed page reuses the stored filters.
        assert.strictEqual(context.requests[1].params.search, 'Ada');
        assert.deepStrictEqual(context.state, {});
    });
});
