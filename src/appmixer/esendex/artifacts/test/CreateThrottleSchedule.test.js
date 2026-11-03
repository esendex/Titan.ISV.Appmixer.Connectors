'use strict';

const assert = require('assert');

const CreateThrottleSchedule = require('../../core/CreateThrottleSchedule/CreateThrottleSchedule.js');

// The documented 201 response body (data object).
const CREATED = {
    throttleScheduleId: '9ecac452-f585-4b1f-be45-7657a8583521',
    estimatedEndDateTime: '2025-07-10T15:51:00.0000000Z',
    numberOfRecipients: 1
};

// Minimal Appmixer context mock for CreateThrottleSchedule.receive().
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

// Valid rate-based baseline input, overridable per test.
function rateContent(overrides = {}) {

    return {
        scheduleType: 'rate',
        startDate: '2030-01-01',
        timeSlotStart: '15:30:00',
        rateOfSend: 100,
        messageText: 'Hello from a throttled schedule',
        recipients: '+447700900123',
        ...overrides
    };
}

describe('Esendex CreateThrottleSchedule', function() {

    it('throws CancelError when start date is missing', async function() {

        const context = createContext({ content: rateContent({ startDate: '' }) });

        await assert.rejects(
            () => CreateThrottleSchedule.receive(context),
            err => err.name === 'CancelError' && /Start Date/.test(err.message)
        );
    });

    it('throws CancelError when time slot start is missing', async function() {

        const context = createContext({ content: rateContent({ timeSlotStart: '' }) });

        await assert.rejects(
            () => CreateThrottleSchedule.receive(context),
            err => err.name === 'CancelError' && /Time Slot Start/.test(err.message)
        );
    });

    it('throws CancelError when message text is missing', async function() {

        const context = createContext({ content: rateContent({ messageText: '' }) });

        await assert.rejects(
            () => CreateThrottleSchedule.receive(context),
            err => err.name === 'CancelError' && /Message Text/.test(err.message)
        );
    });

    it('throws CancelError when neither recipients nor contact IDs are provided', async function() {

        const context = createContext({ content: rateContent({ recipients: '' }) });

        await assert.rejects(
            () => CreateThrottleSchedule.receive(context),
            err => err.name === 'CancelError' && /recipient number or contact ID/.test(err.message)
        );
    });

    it('throws CancelError when a rate-based schedule has no rate of send', async function() {

        const context = createContext({ content: rateContent({ rateOfSend: '' }) });

        await assert.rejects(
            () => CreateThrottleSchedule.receive(context),
            err => err.name === 'CancelError' && /Rate Of Send/.test(err.message)
        );
    });

    it('throws CancelError when a period-based schedule has no end date or end time', async function() {

        const noEndDate = createContext({
            content: rateContent({ scheduleType: 'period', timeSlotEnd: '16:30:00' })
        });
        await assert.rejects(
            () => CreateThrottleSchedule.receive(noEndDate),
            err => err.name === 'CancelError' && /End Date/.test(err.message)
        );

        const noEndTime = createContext({
            content: rateContent({ scheduleType: 'period', endDate: '2030-01-02' })
        });
        await assert.rejects(
            () => CreateThrottleSchedule.receive(noEndTime),
            err => err.name === 'CancelError' && /Time Slot End/.test(err.message)
        );
    });

    it('throws CancelError on an invalid day of week', async function() {

        const context = createContext({ content: rateContent({ daysOfWeek: 'Monday, Someday' }) });

        await assert.rejects(
            () => CreateThrottleSchedule.receive(context),
            err => err.name === 'CancelError' && /Invalid day/.test(err.message)
        );
    });

    it('builds a rate-based request with auth headers and normalized inputs', async function() {

        const context = createContext({
            content: rateContent({
                // Full date-time from the picker and a short time - both normalized.
                startDate: '2030-01-01T00:00:00.000Z',
                timeSlotStart: '9:30',
                rateOfSend: '100',
                daysOfWeek: ['monday', 'Friday'],
                from: 'MyBrand',
                name: 'Campaign A',
                characterSet: 'Auto',
                messageType: 'MarketingAndResearch',
                contactIds: 'c129b89f-515a-43e1-b990-91fc2de3d566',
                metaData: '{"campaignId": "123"}'
            })
        });

        await CreateThrottleSchedule.receive(context);

        assert.strictEqual(context.requests.length, 1);
        const request = context.requests[0];
        assert.strictEqual(request.method, 'POST');
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/throttle-schedule');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.strictEqual(request.headers['X-External-Source'], 'Appmixer');
        assert.strictEqual(request.headers['AccountReference'], 'EXUK0000000');

        assert.deepStrictEqual(request.data.throttleScheduleInformation, {
            startDate: '2030-01-01',
            timeSlotStart: '09:30:00',
            rateOfSend: 100,
            daysOfWeek: ['Monday', 'Friday']
        });
        assert.deepStrictEqual(request.data.dispatch, {
            channel: 'SMS',
            body: { text: 'Hello from a throttled schedule' },
            from: 'MyBrand',
            name: 'Campaign A',
            characterSet: 'Auto',
            messageType: 'MarketingAndResearch'
        });
        assert.deepStrictEqual(request.data.recipients, [{ msisdn: '+447700900123' }]);
        assert.deepStrictEqual(request.data.contacts, [{ contactId: 'c129b89f-515a-43e1-b990-91fc2de3d566' }]);
        assert.deepStrictEqual(request.data.metaData, { campaignId: '123' });
    });

    it('builds a period-based request without a rate of send', async function() {

        const context = createContext({
            content: rateContent({
                scheduleType: 'period',
                rateOfSend: '',
                endDate: '2030-01-03',
                timeSlotEnd: '16:30:00'
            })
        });

        await CreateThrottleSchedule.receive(context);

        assert.deepStrictEqual(context.requests[0].data.throttleScheduleInformation, {
            startDate: '2030-01-01',
            timeSlotStart: '15:30:00',
            endDate: '2030-01-03',
            timeSlotEnd: '16:30:00'
        });
    });

    it('sends the created schedule to the out port', async function() {

        const context = createContext({ content: rateContent() });

        await CreateThrottleSchedule.receive(context);

        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.sent[0].port, 'out');
        assert.deepStrictEqual(context.sent[0].data, CREATED);
    });

    it('throws CancelError on invalid metadata JSON', async function() {

        const context = createContext({ content: rateContent({ metaData: '{not json' }) });

        await assert.rejects(
            () => CreateThrottleSchedule.receive(context),
            err => err.name === 'CancelError' && /must be valid JSON/.test(err.message)
        );
    });

    it('surfaces the structured Esendex error list on HTTP errors', async function() {

        const httpError = new Error('Request failed with status code 400');
        httpError.response = {
            data: {
                errors: [{ errorCode: 'validationError', errorMessage: 'startDate is invalid' }]
            }
        };
        const context = createContext({ content: rateContent(), httpError });

        await assert.rejects(
            () => CreateThrottleSchedule.receive(context),
            err => /Esendex API error: validationError: startDate is invalid/.test(err.message)
        );
    });
});
