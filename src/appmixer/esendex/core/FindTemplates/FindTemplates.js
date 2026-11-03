'use strict';

const lib = require('../../lib');

// Schema of a single template record as returned by GET /v2/templates
// (https://developer.esendex.co.uk, Templates -> Get all). Used to generate
// the dynamic output port options for the selected output type.
const outputSchema = {
    id: { type: 'string', title: 'Template ID' },
    name: { type: 'string', title: 'Name' },
    content: { type: 'string', title: 'Content' },
    type: { type: 'string', title: 'Type' },
    messageType: { type: 'string', title: 'Message Type' },
    accountReference: { type: 'string', title: 'Account Reference' },
    createTimestamp: { type: 'string', title: 'Created At' },
    lastUpdateTimestamp: { type: 'string', title: 'Last Updated At' },
    createdBy: { type: 'string', title: 'Created By' },
    lastUpdatedBy: { type: 'string', title: 'Last Updated By' },
    channelSettings: { type: 'array', title: 'Channel Settings' },
    variables: { type: 'array', title: 'Variables' },
    isLocked: { type: 'boolean', title: 'Is Locked' },
    tags: { type: 'array', title: 'Tags' }
};

module.exports = {

    async receive(context) {

        const {
            search,
            createdStartDate,
            createdEndDate,
            sortBy,
            sortOrder,
            outputType
        } = context.messages.in.content;

        // Designer side-call (out port `source`): describe the output shape for
        // the selected output type - no API call is made in this mode.
        if (context.properties.generateOutputPortOptions) {
            return lib.getOutputPortOptions(context, outputType, outputSchema, {
                label: 'Templates',
                value: 'result'
            });
        }

        // The API paginates with a default page size of 1 - always request the
        // documented maximum (1000) and return a single page.
        // Our inputs are camelCase; the query parameters use the casing from the
        // API docs. Empty values ("Default" select options) omit the parameter
        // so the API applies its own defaults.
        const params = { PageSize: 1000 };
        if (search) {
            params.Search = search;
        }
        if (createdStartDate) {
            params.CreatedStartDate = createdStartDate;
        }
        if (createdEndDate) {
            params.CreatedEndDate = createdEndDate;
        }
        if (sortBy) {
            params.sortBy = sortBy;
        }
        if (sortOrder) {
            params.sortOrder = sortOrder;
        }

        let response;
        try {
            // Single-page by design: templates are capped at one max-size page
            // (1000), which doubles as the SendMessage dropdown source. Uses the
            // shared 429/Retry-After backoff.
            response = await lib.requestWithRetry(context, {
                method: 'GET',
                url: `${lib.getBaseUrl(context.auth)}/v2/templates`,
                headers: {
                    'X-Api-Key': context.auth.apiKey,
                    'AccountReference': context.auth.accountReference
                },
                params
            });
        } catch (err) {
            // Called as a dropdown source: return an empty result instead of
            // surfacing an error popup in the Designer (guideline rule).
            if (context.properties.isSource) {
                return context.sendJson({ result: [], count: 0 }, 'out');
            }
            // Surface Esendex's structured error list when present (shared helper).
            throw lib.toApiError(context, err);
        }

        // 200 OK -> { data: { templates: [...], totalCount, currentPage, totalPages } }
        const templates = (response.data && response.data.data && response.data.data.templates) || [];

        if (!templates.length) {
            // As a dropdown source, an account with no templates must still
            // produce an `out` message - the picker transform runs on the out
            // port and would crash on the empty notFound alternative.
            if (context.properties.isSource) {
                return context.sendJson({ result: [], count: 0 }, 'out');
            }
            return context.sendJson({}, 'notFound');
        }

        return lib.sendArrayOutput({ context, records: templates, outputType });
    }, toSelectArray(out) {
        // Defensive: called by the Designer with whatever the out port carried,
        // which can be nothing at all.
        return ((out && out.result) || []).map(({ name, id }) => ({ label: name, value: id }));
    }
};
