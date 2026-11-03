'use strict';

const assert = require('assert');

const CreateContact = require('../../core/CreateContact/CreateContact.js');

// The documented 201 response body (data object, trimmed).
const CREATED = {
    contactId: 'c129b89f-515a-43e1-b990-91fc2de3d566',
    accountReference: 'EXUK0000000',
    firstName: 'John',
    lastName: 'Mclane'
};

// Minimal Appmixer context mock for CreateContact.receive().
function createContext({ content = {}, httpError } = {}) {

    const context = {
        auth: {
            apiKey: 'test-api-key',
            accountReference: 'EXUK0000000'
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
            return { data: { data: CREATED } };
        },
        sendJson: (data, port) => {
            context.sent.push({ data, port });
            return Promise.resolve();
        }
    };
    return context;
}

describe('Esendex CreateContact', function() {

    it('throws CancelError when first name is missing', async function() {

        const context = createContext({ content: { lastName: 'Mclane' } });

        await assert.rejects(
            () => CreateContact.receive(context),
            err => err.name === 'CancelError' && /First Name/.test(err.message)
        );
    });

    it('throws CancelError when last name is missing', async function() {

        const context = createContext({ content: { firstName: 'John' } });

        await assert.rejects(
            () => CreateContact.receive(context),
            err => err.name === 'CancelError' && /Last Name/.test(err.message)
        );
    });

    it('creates the contact and outputs the echoed record', async function() {

        const context = createContext({
            content: {
                firstName: 'John',
                lastName: 'Mclane',
                quickName: 'Bruce',
                // expression inspector shape: repeatable rows under ADD;
                // the empty row must be ignored.
                addresses: {
                    ADD: [
                        { addressType: 'Msisdn', addressValue: '+447711000022', optOutStatus: 'Subscribed' },
                        { addressType: 'Email', addressValue: '' }
                    ]
                },
                // key-value inspector shape
                contactMetadata: [{ key: 'team', value: 'octopus' }]
            }
        });

        await CreateContact.receive(context);

        const request = context.requests[0];
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/contacts');
        assert.strictEqual(request.method, 'POST');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.deepStrictEqual(request.data, {
            accountReference: 'EXUK0000000',   // from auth, not an input
            firstName: 'John',
            lastName: 'Mclane',
            quickName: 'Bruce',
            addresses: [
                { addressType: 'Msisdn', addressValue: '+447711000022', optOutStatus: 'Subscribed' }
            ],
            contactMetadata: { team: 'octopus' }
        });

        assert.strictEqual(context.sent[0].port, 'out');
        assert.deepStrictEqual(context.sent[0].data, CREATED);
    });

    it('omits optional fields that were not provided', async function() {

        const context = createContext({
            content: { firstName: 'John', lastName: 'Mclane' }
        });

        await CreateContact.receive(context);

        assert.deepStrictEqual(context.requests[0].data, {
            accountReference: 'EXUK0000000',
            firstName: 'John',
            lastName: 'Mclane'
        });
    });

    it('defaults the address type to Msisdn when not selected', async function() {

        const context = createContext({
            content: {
                firstName: 'John',
                lastName: 'Mclane',
                addresses: { ADD: [{ addressValue: '+447711000022' }] }
            }
        });

        await CreateContact.receive(context);

        assert.deepStrictEqual(context.requests[0].data.addresses, [
            { addressType: 'Msisdn', addressValue: '+447711000022' }
        ]);
    });

    it('surfaces the structured error list on API failures (e.g. 409 duplicate)', async function() {

        const httpError = new Error('Request failed with status code 409');
        httpError.response = {
            data: {
                errors: [{ errorCode: 'contact_already_exists', errorMessage: 'Contact already exists.' }]
            }
        };

        const context = createContext({
            content: { firstName: 'John', lastName: 'Mclane' },
            httpError
        });

        await assert.rejects(
            () => CreateContact.receive(context),
            err => /contact_already_exists: Contact already exists\./.test(err.message)
        );
    });
});
