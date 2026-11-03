'use strict';

const assert = require('assert');

const SendMessage = require('../../core/SendMessage/SendMessage.js');

// Minimal Appmixer context mock: just enough surface for SendMessage.receive().
// `httpRequest` resolves with `httpResponse` (or rejects with `httpError`) and
// records the request options so tests can inspect the outgoing call.
function createContext({ content = {}, httpResponse, httpError } = {}) {

    const context = {
        auth: {
            apiKey: 'test-api-key',
            accountReference: 'EXUK0000000'
            // no baseUrl on purpose -> lib.js must fall back to the production URL
        },
        messages: { in: { content } },
        CancelError: class CancelError extends Error {
            constructor(message) {
                super(message);
                this.name = 'CancelError';
            }
        },
        sent: [],
        requests: [],
        httpRequest: async options => {
            context.requests.push(options);
            if (httpError) {
                throw httpError;
            }
            return httpResponse || { data: { data: { requestId: 'req-1', messageIds: ['msg-1'] } } };
        },
        sendJson: (data, port) => {
            context.sent.push({ data, port });
            return Promise.resolve();
        }
    };
    return context;
}

describe('Esendex SendMessage', function() {

    it('throws CancelError when neither message text nor template ID is provided', async function() {

        const context = createContext({ content: { recipients: '+447700900123' } });

        await assert.rejects(
            () => SendMessage.receive(context),
            err => err.name === 'CancelError' && /Message text|Template ID/.test(err.message)
        );
    });

    it('throws CancelError when no recipient, contact or group is provided', async function() {

        const context = createContext({ content: { messageText: 'Hello' } });

        await assert.rejects(
            () => SendMessage.receive(context),
            err => err.name === 'CancelError' && /recipient/.test(err.message)
        );
    });

    it('throws CancelError when metadata is not valid JSON', async function() {

        const context = createContext({
            content: {
                messageText: 'Hello',
                recipients: '+447700900123',
                metaData: '{not json'
            }
        });

        await assert.rejects(
            () => SendMessage.receive(context),
            err => err.name === 'CancelError' && /JSON/.test(err.message)
        );
    });

    it('sends the message and outputs requestId and messageIds', async function() {

        const context = createContext({
            content: {
                messageText: 'Hello',
                // Mixed separators on purpose: both numbers must be parsed out.
                recipients: '+447700900123\n+447700900124',
                from: 'MyBrand'
            }
        });

        await SendMessage.receive(context);

        // Outgoing request: production base URL, API key header, hardcoded SMS channel.
        assert.strictEqual(context.requests.length, 1);
        const request = context.requests[0];
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/messages');
        assert.strictEqual(request.method, 'POST');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.strictEqual(request.headers['X-External-Source'], 'Appmixer');
        assert.strictEqual(request.data.accountReference, 'EXUK0000000');
        assert.strictEqual(request.data.channel, 'SMS');
        assert.strictEqual(request.data.from, 'MyBrand');
        assert.deepStrictEqual(request.data.recipients, [
            { msisdn: '+447700900123' },
            { msisdn: '+447700900124' }
        ]);

        // Output message on the 'out' port with the ids from the 202 response.
        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.sent[0].port, 'out');
        assert.deepStrictEqual(context.sent[0].data, { requestId: 'req-1', messageIds: ['msg-1'] });
    });

    it('maps address-book contacts and groups into the addressBook payload', async function() {

        const context = createContext({
            content: {
                templateId: 'c1fa7d5e-46a0-47fc-83da-1f44a99edd92',
                contactIds: 'contact-1, contact-2',
                groupIds: 'group-1'
            }
        });

        await SendMessage.receive(context);

        const request = context.requests[0];
        assert.strictEqual(request.data.body.templateId, 'c1fa7d5e-46a0-47fc-83da-1f44a99edd92');
        assert.deepStrictEqual(request.data.addressBook, {
            contacts: [{ id: 'contact-1' }, { id: 'contact-2' }],
            groups: [{ id: 'group-1' }]
        });
        // No raw recipients were given, so the property must be absent.
        assert.strictEqual(request.data.recipients, undefined);
    });

    it('surfaces the structured Esendex error list on API failures', async function() {

        const httpError = new Error('Request failed with status code 400');
        httpError.response = {
            data: {
                errors: [{ errorCode: 'invalidOriginator', errorMessage: 'The from field is invalid.' }]
            }
        };

        const context = createContext({
            content: { messageText: 'Hello', recipients: '+447700900123' },
            httpError
        });

        await assert.rejects(
            () => SendMessage.receive(context),
            err => /invalidOriginator: The from field is invalid\./.test(err.message)
        );
    });
});
