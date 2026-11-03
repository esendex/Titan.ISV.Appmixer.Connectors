'use strict';

const lib = require('../../lib');

// Split a textarea value (newline / comma / semicolon separated) into a trimmed list.
function toList(value) {

    if (Array.isArray(value)) {
        return value.map(v => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
    }
    return [];
}

// Accept either an already-parsed object or a JSON string (the metaData input).
function parseObject(context, value, label) {

    if (!value) {
        return undefined;
    }
    if (typeof value === 'object') {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch (err) {
        throw new context.CancelError(`"${label}" must be valid JSON (${err.message}).`);
    }
}

module.exports = {

    async receive(context) {

        // Credentials come from the connected account (auth.js), never from inputs.
        const { apiKey, accountReference } = context.auth;

        const {
            from,
            messageText,
            templateId,
            shortenUrlBrand,
            recipients,
            contactIds,
            groupIds,
            name,
            characterSet,
            messageType,
            validity,
            attachmentUrl,
            attachmentFileName,
            attachmentDescription,
            metaData
        } = context.messages.in.content;

        // The API requires either a message text or a template. This is a conditional
        // requirement (one of two fields), so it is validated here rather than in the
        // component.json schema `required` list.
        if (!messageText && !templateId) {
            throw new context.CancelError('Provide either "Message text" or "Template ID".');
        }

        // Message body: text OR template, plus optional extras.
        const body = {};
        if (messageText) {
            body.text = messageText;
        }
        if (templateId) {
            body.templateId = templateId;
        }
        if (shortenUrlBrand) {
            body.shortenUrlBrand = shortenUrlBrand;
        }
        if (attachmentUrl) {
            body.attachment = { attachmentUrl };
            if (attachmentFileName) {
                body.attachment.fileName = attachmentFileName;
            }
            if (attachmentDescription) {
                body.attachment.description = attachmentDescription;
            }
        }

        // Recipients: raw MSISDNs and/or address-book contacts/groups. At least one
        // of the three sources must be provided (again a conditional requirement).
        const recipientList = toList(recipients).map(msisdn => ({ msisdn }));
        const contactList = toList(contactIds).map(id => ({ id }));
        const groupList = toList(groupIds).map(id => ({ id }));

        if (!recipientList.length && !contactList.length && !groupList.length) {
            throw new context.CancelError('Provide at least one recipient number, contact ID or group ID.');
        }

        const payload = {
            accountReference,
            // The Messaging API currently supports a single channel (SMS), so the
            // value is hardcoded instead of exposing a one-option select input.
            channel: 'SMS',
            body
        };
        if (from) {
            payload.from = from;
        }
        if (name) {
            payload.name = name;
        }
        if (characterSet) {
            payload.characterSet = characterSet;
        }
        if (messageType) {
            payload.messageType = messageType;
        }
        if (validity) {
            payload.validity = validity;
        }
        if (recipientList.length) {
            payload.recipients = recipientList;
        }
        if (contactList.length || groupList.length) {
            payload.addressBook = {};
            if (contactList.length) {
                payload.addressBook.contacts = contactList;
            }
            if (groupList.length) {
                payload.addressBook.groups = groupList;
            }
        }
        const meta = parseObject(context, metaData, 'Metadata');
        if (meta) {
            payload.metaData = meta;
        }

        let response;
        try {
            response = await context.httpRequest({
                url: `${lib.getBaseUrl(context.auth)}/v2/messages`,
                method: 'POST',
                headers: lib.withExternalSource({
                    'X-Api-Key': apiKey,
                    'Content-Type': 'application/json'
                }),
                data: payload
            });
        } catch (err) {
            // Surface Esendex's structured error list when present (shared helper).
            throw lib.toApiError(context, err);
        }

        // 202 Accepted -> { data: { requestId, messageIds } }
        const result = (response && response.data && response.data.data) || {};

        return context.sendJson({
            requestId: result.requestId,
            messageIds: result.messageIds || []
        }, 'out');
    }
};
