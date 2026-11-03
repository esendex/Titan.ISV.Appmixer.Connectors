'use strict';

const assert = require('assert');

const lib = require('../../lib.js');

// Minimal context: toApiError only needs CancelError.
const context = {
    CancelError: class CancelError extends Error {
        constructor(message) {
            super(message);
            this.name = 'CancelError';
        }
    }
};

function httpError(status, errors) {

    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status };
    if (errors) {
        err.response.data = { errors };
    }
    return err;
}

describe('Esendex lib.toApiError (CO-3911 retry semantics)', function() {

    it('turns permanent 4xx errors into CancelError so the engine does not retry', function() {

        for (const status of [400, 401, 403, 404, 409, 422]) {
            const result = lib.toApiError(context, httpError(status, [
                { errorCode: 'someError', errorMessage: 'permanent problem' }
            ]));
            assert.strictEqual(result.name, 'CancelError', `status ${status}`);
            assert.ok(/Esendex API error: someError: permanent problem/.test(result.message));
        }
    });

    it('turns a permanent 4xx without a structured body into CancelError with the original message', function() {

        const result = lib.toApiError(context, httpError(404));
        assert.strictEqual(result.name, 'CancelError');
        assert.ok(/status code 404/.test(result.message));
    });

    it('keeps transient failures retryable (regular errors)', function() {

        for (const status of [408, 429, 500, 502, 503]) {
            const result = lib.toApiError(context, httpError(status, [
                { errorCode: 'transientError', errorMessage: 'try again' }
            ]));
            assert.notStrictEqual(result.name, 'CancelError', `status ${status}`);
            assert.ok(/Esendex API error: transientError: try again/.test(result.message));
        }
    });

    it('returns network errors (no response) unchanged', function() {

        const err = new Error('socket hang up');
        assert.strictEqual(lib.toApiError(context, err), err);
    });

    it('formats multiple structured errors into one message', function() {

        const result = lib.toApiError(context, httpError(400, [
            { errorCode: 'a', errorMessage: 'first' },
            { errorCode: 'b', errorMessage: 'second' }
        ]));
        assert.ok(/a: first; b: second/.test(result.message));
    });
});

describe('Esendex lib.withExternalSource (CO-4491)', function() {

    it('adds X-External-Source and keeps the existing headers', function() {

        const headers = lib.withExternalSource({ 'X-Api-Key': 'test-api-key' });
        assert.deepStrictEqual(headers, {
            'X-Api-Key': 'test-api-key',
            'X-External-Source': 'Appmixer'
        });
    });

    it('works without headers and does not mutate the input', function() {

        assert.deepStrictEqual(lib.withExternalSource(), { 'X-External-Source': 'Appmixer' });
        const input = { 'X-Api-Key': 'k' };
        lib.withExternalSource(input);
        assert.deepStrictEqual(input, { 'X-Api-Key': 'k' });
    });
});
