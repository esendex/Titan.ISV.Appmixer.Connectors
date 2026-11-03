'use strict';

const assert = require('assert');

const FindTemplates = require('../../core/FindTemplates/FindTemplates.js');

// A documented sample record from GET /v2/templates (trimmed).
const TEMPLATE = {
    id: '486c5ddf-e047-49bf-a5ed-b3e3555f8843',
    name: 'Template_999',
    content: 'This is a template body',
    type: 'Text',
    messageType: 'MarketingAndResearch',
    isLocked: false
};

// Minimal Appmixer context mock for FindTemplates.receive(). `templatesData`
// becomes the `templates` array of the API response.
function createContext({ content = {}, properties = {}, templatesData = [TEMPLATE], httpError } = {}) {

    const context = {
        auth: {
            apiKey: 'test-api-key',
            accountReference: 'EXUK0000000'
        },
        properties,
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
            return { data: { data: { templates: templatesData, totalCount: templatesData.length } } };
        },
        sendJson: (data, port) => {
            context.sent.push({ data, port });
            return Promise.resolve();
        }
    };
    return context;
}

describe('Esendex FindTemplates', function() {

    it('generates output port options without calling the API (array mode)', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            properties: { generateOutputPortOptions: true }
        });

        await FindTemplates.receive(context);

        // No HTTP call in options-generation mode.
        assert.strictEqual(context.requests.length, 0);
        // Array mode declares a single 'result' option holding the record array.
        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data[0].label, 'Templates');
        assert.strictEqual(context.sent[0].data[0].value, 'result');
        assert.strictEqual(context.sent[0].data[0].schema.type, 'array');
    });

    it('queries with max page size, auth headers and mapped filter parameters', async function() {

        const context = createContext({
            content: {
                outputType: 'array',
                search: 'welcome',
                createdStartDate: '2026-01-01T00:00:00Z',
                sortBy: 'name'
                // sortOrder and createdEndDate left empty on purpose: the
                // parameters must be omitted so the API applies its defaults.
            }
        });

        await FindTemplates.receive(context);

        const request = context.requests[0];
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/templates');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.strictEqual(request.headers['AccountReference'], 'EXUK0000000');
        // camelCase inputs are mapped to the API's documented parameter casing;
        // Find components hide pagination: always the maximum page size.
        assert.deepStrictEqual(request.params, {
            PageSize: 1000,
            Search: 'welcome',
            CreatedStartDate: '2026-01-01T00:00:00Z',
            sortBy: 'name'
        });

        // Array output: field is always `result`, with the total count.
        assert.strictEqual(context.sent[0].port, 'out');
        assert.deepStrictEqual(context.sent[0].data, { result: [TEMPLATE], count: 1 });
    });

    it('sends to the notFound port when no template matches', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            templatesData: []
        });

        await FindTemplates.receive(context);

        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.sent[0].port, 'notFound');
        assert.deepStrictEqual(context.sent[0].data, {});
    });

    it('sends an empty result to the out port when called as a dropdown source with no templates', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            properties: { isSource: true },
            templatesData: []
        });

        await FindTemplates.receive(context);

        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.sent[0].port, 'out');
        assert.deepStrictEqual(context.sent[0].data, { result: [], count: 0 });
    });

    it('toSelectArray tolerates a missing or empty out message', function() {

        assert.deepStrictEqual(FindTemplates.toSelectArray(undefined), []);
        assert.deepStrictEqual(FindTemplates.toSelectArray({}), []);
        assert.deepStrictEqual(
            FindTemplates.toSelectArray({ result: [{ id: 't-1', name: 'Welcome' }] }),
            [{ label: 'Welcome', value: 't-1' }]
        );
    });

    it('outputs the first record with index and count in first mode', async function() {

        const other = { ...TEMPLATE, id: 'second-template' };
        const context = createContext({
            content: { outputType: 'first' },
            templatesData: [TEMPLATE, other]
        });

        await FindTemplates.receive(context);

        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data.id, TEMPLATE.id);
        assert.strictEqual(context.sent[0].data.index, 0);
        assert.strictEqual(context.sent[0].data.count, 2);
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
            () => FindTemplates.receive(context),
            err => /unauthenticatedError: Request was unauthenticated/.test(err.message)
        );
    });
});
