'use strict';

const lib = require('../../lib');

// Shape of a single opt-out from GET /v2/optouts (data.optOuts[]). Used to
// build the dynamic output port options (the variable picker) for the
// selected output type.
const ITEM_SCHEMA = {
    type: 'object',
    properties: {
        id: { type: 'string', title: 'Opt-Out ID', example: 'b5a5a418-294a-42a1-ae23-ecb2168dcd39' },
        accountReference: { type: 'string', title: 'Account Reference', example: 'EXUK0000000' },
        channel: { type: 'string', title: 'Channel', example: 'SMS' },
        value: { type: 'string', title: 'Address (Phone Number)', example: '+447700900123' },
        createTimestamp: { type: 'string', title: 'Created At', example: '2026-01-15T09:30:00Z' }
    }
};

// Static routing shared by fresh runs and timeout continuations of 'object' exports.
// This endpoint takes PascalCase query parameters (PageSize/PageNo).
const FIND = {
    endpointPath: '/v2/optouts',
    itemsKey: 'optOuts',
    label: 'opt-outs',
    pageParamCase: 'pascal'
};

module.exports = {

    ITEM_SCHEMA,

    async receive(context) {

        // A scheduled timeout continues a paused 'object' export from its checkpoint.
        if (context.messages.timeout) {
            return lib.resumePaginatedFind({ context, ...FIND });
        }

        const {
            address,
            channel,
            optOutMethod,
            startTime,
            endTime,
            sortBy,
            sortOrder,
            outputType
        } = context.messages.in.content;

        // The Designer calls this (via the out port `source` block) to build the
        // variable picker for the chosen output type - no API call is made here.
        if (context.properties.generateOutputPortOptions) {
            return lib.getOutputPortOptions(context, outputType, ITEM_SCHEMA.properties, {
                label: 'Opt-Outs',
                value: 'result'
            });
        }

        // Build the query from the filters (all optional; empty ones are omitted).
        // Our inputs are camelCase; the query parameters use the casing from the
        // API docs. Pagination (PageSize/PageNo) is handled in the loop below.
        const params = {};
        if (address) {
            params.Address = address;
        }
        if (channel) {
            params.Channel = channel;
        }
        if (optOutMethod) {
            params.OptOutMethod = optOutMethod;
        }
        if (startTime) {
            params.StartTime = startTime;
        }
        if (endTime) {
            params.EndTime = endTime;
        }
        if (sortBy) {
            params.SortBy = sortBy;
        }
        if (sortOrder) {
            params.SortOrder = sortOrder;
        }

        // The page loop, its stop conditions (end of data / size budget / time
        // deadline), 429 backoff and the per-output-type delivery all live in
        // the shared engine - see lib.runPaginatedFind.
        return lib.runPaginatedFind({ context, outputType, filterParams: params, ...FIND });
    }
};
