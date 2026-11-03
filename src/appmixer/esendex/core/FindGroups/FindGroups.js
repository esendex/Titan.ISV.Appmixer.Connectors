'use strict';

const lib = require('../../lib');

// Shape of a single group from GET /v2/groups (data.groups[]).
// Used to build the dynamic output port options (the variable picker) for the
// selected output type.
const ITEM_SCHEMA = {
    type: 'object',
    properties: {
        groupId: { type: 'string', title: 'Group ID', example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' },
        accountReference: { type: 'string', title: 'Account Reference', example: 'EXUK0000000' },
        name: { type: 'string', title: 'Name', example: 'VIP customers' },
        description: { type: 'string', title: 'Description', example: 'Customers on the VIP plan' },
        contactsCount: { type: 'integer', title: 'Contact Count', example: 42 },
        lastUpdatedBy: { type: 'string', title: 'Last Updated By', example: 'jane.doe@example.com' },
        createTimestamp: { type: 'string', title: 'Created At', example: '2026-01-15T09:30:00Z' },
        lastUpdateTimestamp: { type: 'string', title: 'Last Update At', example: '2026-02-01T14:00:00Z' }
    }
};

// Static routing shared by fresh runs and timeout continuations of 'object' exports.
const FIND = {
    endpointPath: '/v2/groups',
    itemsKey: 'groups',
    label: 'groups',
    pageParamCase: 'camel'
};

module.exports = {

    ITEM_SCHEMA,

    async receive(context) {

        // A scheduled timeout continues a paused 'object' export from its checkpoint.
        if (context.messages.timeout) {
            return lib.resumePaginatedFind({ context, ...FIND });
        }

        const {
            name,
            groupOwnership,
            sortBy,
            sortOrder,
            outputType
        } = context.messages.in.content;

        // The Designer calls this (via the out port `source` block) to build the
        // variable picker for the chosen output type - no API call is made here.
        if (context.properties.generateOutputPortOptions) {
            return lib.getOutputPortOptions(context, outputType, ITEM_SCHEMA.properties, {
                label: 'Groups',
                value: 'result'
            });
        }

        // Build the query from the filters (all optional; empty ones are omitted).
        // Pagination (pageSize/pageNo) is handled in the request loop below.
        const params = {};
        if (name) {
            params.name = name;
        }
        if (groupOwnership) {
            params.groupOwnership = groupOwnership;
        }
        if (sortBy) {
            params.sortBy = sortBy;
        }
        if (sortOrder) {
            params.sortOrder = sortOrder;
        }

        // The page loop, its stop conditions (end of data / size budget / time
        // deadline), 429 backoff and the per-output-type delivery all live in
        // the shared engine - see lib.runPaginatedFind.
        return lib.runPaginatedFind({ context, outputType, filterParams: params, ...FIND });
    }
};
