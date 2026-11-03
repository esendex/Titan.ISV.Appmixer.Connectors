'use strict';

const lib = require('./lib');

module.exports = {

    type: 'apiKey',

    definition: {

        auth: {
            apiKey: {
                type: 'text',
                name: 'API Key',
                tooltip: 'Log into the Esendex portal, open the <i>Developer Tools</i> area and create or copy '
                    + 'an API key. It is sent as the <code>X-Api-Key</code> header with every request.'
            },
            accountReference: {
                type: 'text',
                name: 'Account Reference',
                tooltip: 'Your Esendex account reference, e.g. <b>EXUK0000000</b>.'
            },
            baseUrl: {
                type: 'text',
                name: 'Base URL',
                tooltip: 'Optional. API base URL of your Esendex region. Defaults to '
                    + '<code>https://api.esendex.co.uk</code>.'
            }
        },

        // The Messaging API has no profile endpoint, so return the account reference
        // together with an obfuscated API key instead. The development guidelines
        // explicitly allow an obfuscated-key profile when no profile API exists.
        requestProfileInfo: async context => {

            const apiKey = context.apiKey || '';
            const obfuscatedApiKey = apiKey.substring(0, 2) + '...' + apiKey.substring(apiKey.length - 4);

            return { name: `${context.accountReference} (${obfuscatedApiKey})` };
        },

        accountNameFromProfileInfo: 'name',

        // GET /v2/messages is the cheapest authenticated read of the Messaging API.
        // It requires both the X-Api-Key and AccountReference headers, so a single
        // call validates both credentials; it returns 401 when the key is invalid.
        // pageSize=1 keeps the response minimal.
        validate: async context => {

            await context.httpRequest({
                method: 'GET',
                url: `${lib.getBaseUrl(context)}/v2/messages`,
                headers: {
                    'X-Api-Key': context.apiKey,
                    'AccountReference': context.accountReference
                },
                params: { pageSize: 1 }
            });

            return true;
        }
    }
};
