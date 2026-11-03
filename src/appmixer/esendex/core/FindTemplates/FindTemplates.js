'use strict';

const lib = require('../../lib');

// Schema of a single template record as returned by GET /v2/templates
// (https://developer.esendex.co.uk, Templates -> Get all). Used to generate
// the dynamic output port options for the selected output type.
const ITEM_SCHEMA = {
    type: 'object',
    properties: {
        id: { type: 'string', title: 'Template ID', example: '486c5ddf-e047-49bf-a5ed-b3e3555f8843' },
        name: { type: 'string', title: 'Name', example: 'Appointment reminder' },
        content: { type: 'string', title: 'Content', example: 'Hi {{firstName}}, see you tomorrow at {{time}}.' },
        type: { type: 'string', title: 'Type', example: 'Standard' },
        messageType: { type: 'string', title: 'Message Type', example: 'Transactional' },
        accountReference: { type: 'string', title: 'Account Reference', example: 'EXUK0000000' },
        createTimestamp: { type: 'string', title: 'Created At', example: '2026-01-15T09:30:00Z' },
        lastUpdateTimestamp: { type: 'string', title: 'Last Updated At', example: '2026-02-01T14:00:00Z' },
        createdBy: { type: 'string', title: 'Created By', example: 'jane.doe@example.com' },
        lastUpdatedBy: { type: 'string', title: 'Last Updated By', example: 'jane.doe@example.com' },
        channelSettings: { type: 'array', title: 'Channel Settings', example: [{ channel: 'SMS' }] },
        variables: { type: 'array', title: 'Variables', example: ['firstName', 'time'] },
        isLocked: { type: 'boolean', title: 'Is Locked', example: false },
        tags: { type: 'array', title: 'Tags', example: ['reminders'] }
    }
};

module.exports = {

    ITEM_SCHEMA,

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
            return lib.getOutputPortOptions(context, outputType, ITEM_SCHEMA.properties, {
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
