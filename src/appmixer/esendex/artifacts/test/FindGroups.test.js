'use strict';

const assert = require('assert');

const FindGroups = require('../../core/FindGroups/FindGroups.js');

const GROUP = {
    groupId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    name: 'Customers 2026',
    description: 'List of customers for 2026',
    contactsCount: 32645
};

function createContext({ content = {}, properties = {}, groupsData = [GROUP], pages, httpError, config = {} } = {}) {

    const context = {
        auth: {
            apiKey: 'test-api-key',
            accountReference: 'EXUK0000000'
        },
        properties,
        config,
        logs: [],
        log: async entry => { context.logs.push(entry); },
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
            if (pages) {
                const pageNo = options.params.pageNo || 1;
                return { data: { data: { groups: pages[pageNo - 1] || [], totalPages: pages.length } } };
            }
            return { data: { data: { groups: groupsData, totalCount: groupsData.length } } };
        },
        sendJson: (data, port) => {
            context.sent.push({ data, port });
            return Promise.resolve();
        }
    };
    return context;
}

describe('Esendex FindGroups', function() {

    it('generates output port options without calling the API (array mode)', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            properties: { generateOutputPortOptions: true }
        });

        await FindGroups.receive(context);

        assert.strictEqual(context.requests.length, 0);
        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data[0].value, 'result');
        assert.strictEqual(context.sent[0].data[0].schema.type, 'array');
    });

    it('queries /v2/groups with auth headers and only the provided filters', async function() {

        const context = createContext({
            content: { outputType: 'array', name: 'Customers 2026', groupOwnership: 'Owned' }
        });

        await FindGroups.receive(context);

        const request = context.requests[0];
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/groups');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.strictEqual(request.headers['AccountReference'], 'EXUK0000000');
        assert.deepStrictEqual(request.params, {
            name: 'Customers 2026',
            groupOwnership: 'Owned',
            pageSize: 1000,
            pageNo: 1
        });
        assert.deepStrictEqual(context.sent[0].data, { result: [GROUP], count: 1 });
    });

    it('sends to the notFound port when no group matches', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            groupsData: []
        });

        await FindGroups.receive(context);

        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.sent[0].port, 'notFound');
        assert.deepStrictEqual(context.sent[0].data, {});
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
            () => FindGroups.receive(context),
            err => /unauthenticatedError: Request was unauthenticated/.test(err.message)
        );
    });

    it('follows pagination and returns groups from every page', async function() {

        const secondGroup = { ...GROUP, groupId: 'second' };
        const context = createContext({
            content: { outputType: 'array' },
            pages: [[GROUP], [secondGroup]]
        });

        await FindGroups.receive(context);

        assert.strictEqual(context.requests.length, 2);
        assert.strictEqual(context.requests[0].params.pageNo, 1);
        assert.strictEqual(context.requests[1].params.pageNo, 2);
        assert.deepStrictEqual(context.sent[0].data, { result: [GROUP, secondGroup], count: 2 });
    });

    it('rejects array output when the result exceeds the message size budget', async function() {

        // 100-byte message limit -> 70-byte budget; a single real group exceeds it.
        const context = createContext({
            content: { outputType: 'array' },
            config: { messageLimitBytes: '100' }
        });

        await assert.rejects(
            () => FindGroups.receive(context),
            err => err.name === 'CancelError' && /Too many groups/.test(err.message)
        );
    });
});
