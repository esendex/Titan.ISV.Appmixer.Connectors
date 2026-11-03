'use strict';

const lib = require('../../lib');

// Schema of a single message record as returned by GET /v2/messages
// (https://developer.esendex.co.uk, Messaging -> Get all). Used to generate
// the dynamic output port options for the selected output type.
const ITEM_SCHEMA = {
    type: 'object',
    properties: {
        messageId: { type: 'string', title: 'Message ID', example: '8eb5fe15-07d7-49a7-b17a-3011de6d949f' },
        requestId: { type: 'string', title: 'Request ID', example: 'c5a5eddc-b0ad-4147-8e97-e2e25d9ddfb0' },
        accountReference: { type: 'string', title: 'Account Reference', example: 'EXUK0000000' },
        userId: { type: 'string', title: 'User ID', example: '11111111-1111-4111-8111-111111111111' },
        submittedBy: { type: 'string', title: 'Submitted By', example: 'jane.doe@example.com' },
        requestName: { type: 'string', title: 'Request Name', example: 'Spring campaign' },
        source: { type: 'string', title: 'Source', example: 'API' },
        channel: { type: 'string', title: 'Channel', example: 'SMS' },
        messageType: { type: 'string', title: 'Message Type', example: 'Marketing' },
        originator: { type: 'string', title: 'Originator', example: 'Esendex' },
        isBillable: { type: 'boolean', title: 'Is Billable', example: true },
        msisdn: { type: 'string', title: 'Phone Number', example: '+447700900123' },
        submittedMsisdn: { type: 'string', title: 'Submitted Phone Number', example: '07700900123' },
        status: { type: 'string', title: 'Status', example: 'Delivered' },
        reason: { type: 'string', title: 'Reason', example: '' },
        destinationCode: { type: 'string', title: 'Destination Code', example: 'GB' },
        messagePartCount: { type: 'integer', title: 'Message Part Count', example: 1 },
        networkUsed: { type: 'string', title: 'Network Used', example: 'Vodafone UK' },
        route: { type: 'string', title: 'Route', example: 'Standard' },
        submittedAt: { type: 'string', title: 'Submitted At', example: '2026-01-15T09:30:00Z' },
        sentAt: { type: 'string', title: 'Sent At', example: '2026-01-15T09:30:02Z' },
        lastUpdateTimestamp: { type: 'string', title: 'Last Update Timestamp', example: '2026-01-15T09:30:05Z' },
        direction: { type: 'string', title: 'Direction', example: 'Outbound' },
        isDeleted: { type: 'boolean', title: 'Is Deleted', example: false },
        isDeletedBy: { type: 'string', title: 'Is Deleted By', example: '' }
    }
};

// Static routing shared by fresh runs and timeout continuations of 'object' exports.
const FIND = {
    endpointPath: '/v2/messages',
    itemsKey: 'messages',
    label: 'messages',
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
            requestId,
            conversationId,
            msisdn,
            originator,
            status,
            direction,
            startTime,
            endTime,
            outputType
        } = context.messages.in.content;

        // Called by the Designer (through the out port `source` block) to render
        // the variable picker for the selected output type - no API call is made.
        if (context.properties.generateOutputPortOptions) {
            return lib.getOutputPortOptions(context, outputType, ITEM_SCHEMA.properties, {
                label: 'Messages',
                value: 'result'
            });
        }

        // Build the query from the filters (all optional; empty ones are omitted).
        // Appmixer Find components do not expose pagination controls - pagination
        // (pageSize/pageNo) is handled internally in the request loop below.
        const params = {};
        if (requestId) {
            params.requestId = requestId;
        }
        if (conversationId) {
            params.conversationId = conversationId;
        }
        if (msisdn) {
            params.msisdn = msisdn;
        }
        if (originator) {
            params.originator = originator;
        }
        if (status) {
            params.status = status;
        }
        if (direction) {
            params.direction = direction;
        }
        if (startTime) {
            params.startTime = startTime;
        }
        if (endTime) {
            params.endTime = endTime;
        }

        // The page loop, its stop conditions (end of data / size budget / time
        // deadline), 429 backoff and the per-output-type delivery all live in
        // the shared engine - see lib.runPaginatedFind.
        return lib.runPaginatedFind({ context, outputType, filterParams: params, ...FIND });
    }
};
