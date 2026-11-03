'use strict';

const lib = require('../../lib');

// Schema of a single message record as returned by GET /v2/messages
// (https://developer.esendex.co.uk, Messaging -> Get all). Used to generate
// the dynamic output port options for the selected output type.
const outputSchema = {
    messageId: { type: 'string', title: 'Message ID' },
    requestId: { type: 'string', title: 'Request ID' },
    accountReference: { type: 'string', title: 'Account Reference' },
    userId: { type: 'string', title: 'User ID' },
    submittedBy: { type: 'string', title: 'Submitted By' },
    requestName: { type: 'string', title: 'Request Name' },
    source: { type: 'string', title: 'Source' },
    channel: { type: 'string', title: 'Channel' },
    messageType: { type: 'string', title: 'Message Type' },
    originator: { type: 'string', title: 'Originator' },
    isBillable: { type: 'boolean', title: 'Is Billable' },
    msisdn: { type: 'string', title: 'Phone Number' },
    submittedMsisdn: { type: 'string', title: 'Submitted Phone Number' },
    status: { type: 'string', title: 'Status' },
    reason: { type: 'string', title: 'Reason' },
    destinationCode: { type: 'string', title: 'Destination Code' },
    messagePartCount: { type: 'integer', title: 'Message Part Count' },
    networkUsed: { type: 'string', title: 'Network Used' },
    route: { type: 'string', title: 'Route' },
    submittedAt: { type: 'string', title: 'Submitted At' },
    sentAt: { type: 'string', title: 'Sent At' },
    lastUpdateTimestamp: { type: 'string', title: 'Last Update Timestamp' },
    direction: { type: 'string', title: 'Direction' },
    isDeleted: { type: 'boolean', title: 'Is Deleted' },
    isDeletedBy: { type: 'string', title: 'Is Deleted By' }
};

// Static routing shared by fresh runs and timeout continuations of 'object' exports.
const FIND = {
    endpointPath: '/v2/messages',
    itemsKey: 'messages',
    label: 'messages',
    pageParamCase: 'camel'
};

module.exports = {

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
            return lib.getOutputPortOptions(context, outputType, outputSchema, {
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
