'use strict';

const lib = require('../../lib');

// The key-value inspector delivers rows as [{ key, value }, ...] (contactMetadata).
function kvToObj(arr) {

    if (!arr || !Array.isArray(arr)) return {};

    const out = {};
    for (const row of arr) {
        if (!row || typeof row !== 'object') continue;
        const key = row.key;
        if (typeof key !== 'string' || key.length === 0) continue;
        out[key] = row.value;
    }
    return out;
}

module.exports = {

    async receive(context) {

        const {
            firstName,
            lastName,
            quickName,
            addresses,
            contactMetadata
        } = context.messages.in.content;

        if (!firstName) {
            throw new context.CancelError('First Name is required!');
        }
        if (!lastName) {
            throw new context.CancelError('Last Name is required!');
        }

        // The expression inspector delivers repeatable rows as { ADD: [ {...}, ... ] }.
        // Rows without an address value are ignored.
        const addressRows = (addresses && addresses.ADD) || [];
        const addressList = addressRows
            .filter(row => row && row.addressValue)
            .map(row => {
                const address = {
                    addressType: row.addressType || 'Msisdn',
                    addressValue: row.addressValue
                };
                if (row.optOutStatus) {
                    address.optOutStatus = row.optOutStatus;
                }
                return address;
            });

        const payload = {
            // From the connected account, never a component input.
            accountReference: context.auth.accountReference,
            firstName,
            lastName
        };
        if (quickName) {
            payload.quickName = quickName;
        }
        if (addressList.length) {
            payload.addresses = addressList;
        }
        const metadata = kvToObj(contactMetadata);
        if (Object.keys(metadata).length) {
            payload.contactMetadata = metadata;
        }

        let response;
        try {
            response = await context.httpRequest({
                method: 'POST',
                url: `${lib.getBaseUrl(context.auth)}/v2/contacts`,
                headers: {
                    'X-Api-Key': context.auth.apiKey,
                    'Content-Type': 'application/json'
                },
                data: payload
            });
        } catch (err) {
            // Surfaces the structured error list, incl. 409 contact_already_exists.
            throw lib.toApiError(context, err);
        }

        // 201 Created -> { data: { contactId, ...all echoed fields } }
        return context.sendJson((response.data && response.data.data) || {}, 'out');
    }
};
