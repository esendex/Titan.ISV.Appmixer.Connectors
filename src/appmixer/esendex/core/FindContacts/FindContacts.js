'use strict';

const lib = require('../../lib');

// Shape of a single contact from GET /v2/contacts/filter (data.contacts[]).
// Used to build the dynamic output port options (the variable picker) for the
// selected output type.
const outputSchema = {
    contactId: { type: 'string', title: 'Contact ID' },
    accountReference: { type: 'string', title: 'Account Reference' },
    firstName: { type: 'string', title: 'First Name' },
    lastName: { type: 'string', title: 'Last Name' },
    quickName: { type: 'string', title: 'Quick Name' },
    lastUpdatedBy: { type: 'string', title: 'Last Updated By' },
    smsoptOutStatus: { type: 'string', title: 'SMS Opt-Out Status' }, // lower-case 'o' matches the API, not a typo
    createTimestamp: { type: 'string', title: 'Created At' },
    lastUpdateTimestamp: { type: 'string', title: 'Last Update At' },
    addresses: {
        type: 'array',
        title: 'Addresses',
        items: {
            type: 'object',
            properties: {
                addressId: { type: 'string' },
                addressType: { type: 'string' },
                addressValue: { type: 'string' },
                destinationCode: { type: 'string' },
                optOutStatus: { type: 'string' }
            }
        }
    },
    contactMetadata: { type: 'object', title: 'Contact Metadata' }
};

// Static routing shared by fresh runs and timeout continuations of 'object' exports.
const FIND = {
    endpointPath: '/v2/contacts/filter',
    itemsKey: 'contacts',
    label: 'contacts',
    pageParamCase: 'camel'
};

module.exports = {

    async receive(context) {

        // A scheduled timeout continues a paused 'object' export from its checkpoint.
        if (context.messages.timeout) {
            return lib.resumePaginatedFind({ context, ...FIND });
        }

        const {
            search,
            groupId,
            destination,
            optOutStatus,
            contactOwnership,
            sortBy,
            sortOrder,
            outputType
        } = context.messages.in.content;

        // The Designer calls this (via the out port `source` block) to build the
        // variable picker for the chosen output type - no API call is made here.
        if (context.properties.generateOutputPortOptions) {
            return lib.getOutputPortOptions(context, outputType, outputSchema, {
                label: 'Contacts',
                value: 'result'
            });
        }

        // Build the query from the filters (all optional; empty ones are omitted).
        // Pagination (pageSize/pageNo) is handled in the request loop below.
        const params = {};
        if (search) {
            params.search = search;
        }
        if (optOutStatus) {
            params.optOutStatus = optOutStatus;
        }
        if (groupId) {
            params.groupId = groupId;
        }
        if (destination) {
            params.destination = destination;
        }
        if (contactOwnership) {
            params.contactOwnership = contactOwnership;
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
