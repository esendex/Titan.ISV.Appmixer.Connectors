'use strict';

const lib = require('../../lib');

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The API wants a bare YYYY-MM-DD date but the date-time inspector may deliver
// a full date-time value - extract the date part.
function toDateOnly(context, value, label) {

    const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (!match) {
        throw new context.CancelError(`"${label}" must be a date in YYYY-MM-DD format.`);
    }
    return match[1];
}

// The API wants a bare HH:MM:SS UTC time - also accept HH:MM and a full
// date-time value (the time part is extracted).
function toTimeOnly(context, value, label) {

    const match = String(value).trim().match(/(?:^|[T ])(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) {
        throw new context.CancelError(`"${label}" must be a time in HH:MM:SS 24-hour UTC format, e.g. 15:30:00.`);
    }
    return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
}

module.exports = {

    async receive(context) {

        // Credentials come from the connected account (auth.js), never from inputs.
        const { apiKey, accountReference } = context.auth;

        const {
            scheduleType,
            startDate,
            timeSlotStart,
            rateOfSend,
            endDate,
            timeSlotEnd,
            daysOfWeek,
            from,
            messageText,
            recipients,
            contactIds,
            name,
            characterSet,
            messageType,
            metaData
        } = context.messages.in.content;

        if (!startDate) {
            throw new context.CancelError('Start Date is required!');
        }
        if (!timeSlotStart) {
            throw new context.CancelError('Time Slot Start is required!');
        }
        if (!messageText) {
            throw new context.CancelError('Message Text is required!');
        }

        const throttleScheduleInformation = {
            startDate: toDateOnly(context, startDate, 'Start Date'),
            timeSlotStart: toTimeOnly(context, timeSlotStart, 'Time Slot Start')
        };

        if (scheduleType === 'period') {
            // Period-based: the platform derives the optimal hourly rate from the window.
            if (!endDate) {
                throw new context.CancelError('End Date is required for a period-based schedule!');
            }
            if (!timeSlotEnd) {
                throw new context.CancelError('Time Slot End is required for a period-based schedule!');
            }
            throttleScheduleInformation.endDate = toDateOnly(context, endDate, 'End Date');
            throttleScheduleInformation.timeSlotEnd = toTimeOnly(context, timeSlotEnd, 'Time Slot End');
        } else {
            // Rate-based (default): the platform estimates the end date from the rate.
            const rate = Number(rateOfSend);
            if (!rateOfSend || !Number.isInteger(rate) || rate <= 0) {
                throw new context.CancelError('Rate Of Send must be a positive number of messages per hour for a rate-based schedule!');
            }
            throttleScheduleInformation.rateOfSend = rate;
        }

        const days = lib.toList(daysOfWeek).map(day => day.charAt(0).toUpperCase() + day.slice(1).toLowerCase());
        const invalidDays = days.filter(day => !DAYS_OF_WEEK.includes(day));
        if (invalidDays.length) {
            throw new context.CancelError(`Invalid day(s) of week: ${invalidDays.join(', ')}. Allowed values: ${DAYS_OF_WEEK.join(', ')}.`);
        }
        if (days.length) {
            throttleScheduleInformation.daysOfWeek = days;
        }

        // Recipients: raw MSISDNs and/or address-book contacts. At least one of the
        // two sources must be provided (a conditional requirement, so it is
        // validated here rather than in the component.json schema `required` list).
        const recipientList = lib.toList(recipients).map(msisdn => ({ msisdn }));
        const contactList = lib.toList(contactIds).map(contactId => ({ contactId }));

        if (!recipientList.length && !contactList.length) {
            throw new context.CancelError('Provide at least one recipient number or contact ID.');
        }

        const dispatch = {
            // The Throttling API currently supports a single channel (SMS), so the
            // value is hardcoded instead of exposing a one-option select input.
            channel: 'SMS',
            body: { text: messageText }
        };
        if (from) {
            dispatch.from = from;
        }
        if (name) {
            dispatch.name = name;
        }
        if (characterSet) {
            dispatch.characterSet = characterSet;
        }
        if (messageType) {
            dispatch.messageType = messageType;
        }

        const payload = {
            throttleScheduleInformation,
            dispatch,
            // The documented requests always carry both arrays, with the unused
            // source left empty (recipients and contacts are an either/or pair).
            recipients: recipientList,
            contacts: contactList
        };
        const meta = lib.parseObject(context, metaData, 'Metadata');
        if (meta) {
            payload.metaData = meta;
        }

        let response;
        try {
            response = await context.httpRequest({
                url: `${lib.getBaseUrl(context.auth)}/v2/throttle-schedule`,
                method: 'POST',
                headers: lib.withExternalSource({
                    'X-Api-Key': apiKey,
                    // Unlike /v2/messages, this endpoint takes the account
                    // reference as a header instead of a payload field.
                    'AccountReference': accountReference,
                    'Content-Type': 'application/json'
                }),
                data: payload
            });
        } catch (err) {
            // Surface Esendex's structured error list when present (shared helper).
            throw lib.toApiError(context, err);
        }

        // 201 Created -> { data: { throttleScheduleId, estimatedEndDateTime, numberOfRecipients } }
        return context.sendJson((response.data && response.data.data) || {}, 'out');
    }
};
