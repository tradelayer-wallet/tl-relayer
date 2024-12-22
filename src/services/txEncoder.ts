import BigNumber from 'bignumber.js';

const marker = 'tl';

export const Encode = {
    encodeActivateTradeLayer(params: { txTypeToActivate: string | string[]; codeHash: string }): string {
        const txTypeEncoded = Array.isArray(params.txTypeToActivate)
            ? params.txTypeToActivate.join(';')
            : params.txTypeToActivate;
        const base36hex = BigInt('0x' + params.codeHash).toString(36); // Hex to Base 36
        const type = 0;
        return `${marker}${type}${txTypeEncoded},${base36hex}`;
    },

    encodeTokenIssue(params: {
        initialAmount: number;
        ticker: string;
        whitelists: number[];
        managed: boolean;
        backupAddress: string;
        nft: boolean;
    }): string {
        const payload = [
            params.initialAmount.toString(36),
            params.ticker,
            params.whitelists.map((val) => val.toString(36)).join(','),
            params.managed ? '1' : '0',
            params.backupAddress,
            params.nft ? '1' : '0',
        ];
        const type = 1;
        return `${marker}${type.toString(36)}${payload.join(',')}`;
    },

    encodeSend(params: {
        isColoredOutput: boolean;
        sendAll?: boolean;
        propertyId?: string | number | string[];
        amount?: number | number[];
        address?: string;
    }): string {
        const isColoredOutput = params.isColoredOutput ? '1' : '0';
        let payload;

        if (params.sendAll) {
            payload = ['1', params.address, isColoredOutput];
        } else if (Array.isArray(params.propertyId) && Array.isArray(params.amount)) {
            payload = [
                '0', // Not sendAll
                '', // Address is omitted for multi-send
                params.propertyId.map((id) => this.encodePropertyId(id)).join(','),
                params.amount.map((amt) => amt.toString(36)).join(','),
                isColoredOutput,
            ];
        } else {
            const encodedPropertyId = this.encodePropertyId(params.propertyId as string | number);
            payload = [
                '0', // Not sendAll
                params.address,
                encodedPropertyId,
                (params.amount as number).toString(36),
                isColoredOutput,
            ];
        }

        const type = 2;
        return `${marker}${type.toString(36)}${payload.join(';')}`;
    },

    encodePropertyId(propertyId: string | number): string {
        if (typeof propertyId === 'string' && propertyId.startsWith('s-')) {
            const [_, collateralId, contractId] = propertyId.split('-');
            const encodedCollateralId = parseInt(collateralId).toString(36);
            const encodedContractId = parseInt(contractId).toString(36);
            return `s-${encodedCollateralId}-${encodedContractId}`;
        } else {
            return propertyId.toString(36);
        }
    },

    encodeTradeTokenForUTXO(params: {
        propertyId: number;
        amount: number;
        columnA: string;
        satsExpected: number;
        tokenOutput: string;
        payToAddress: string;
        isColoredOutput: boolean;
    }): string {
        const amount = new BigNumber(params.amount).times(1e8).toNumber();
        const sats = new BigNumber(params.satsExpected).times(1e8).toNumber();
        const isColoredOutput = params.isColoredOutput ? '1' : '0';
        const payload = [
            params.propertyId.toString(36),
            amount.toString(36),
            params.columnA,
            sats.toString(36),
            params.tokenOutput,
            params.payToAddress,
            isColoredOutput,
        ];
        const type = 3;
        return `${marker}${type.toString(36)}${payload.join(',')}`;
    },

    encodeCommit(params: {
        propertyId: number;
        amount: number;
        channelAddress: string;
        payEnabled: boolean;
        clearLists?: string | number[] | undefined;
        isColoredOutput: boolean;
        ref?: number;
    }): string {
        const amount = new BigNumber(params.amount).times(1e8).toString(36);
        const channelAddress = params.channelAddress.length > 42 ? `ref:${params.ref || 0}` : params.channelAddress;
        const payEnabled = params.payEnabled ? '1' : '0';
        let clearLists = '';
        if (params.clearLists) {
            if (Array.isArray(params.clearLists)) {
                clearLists = `[${params.clearLists.map((num) => num.toString(36)).join(',')}]`;
            } else {
                clearLists = params.clearLists.toString(36);
            }
        }

        const isColoredOutput = params.isColoredOutput ? '1' : '0';
        const payload = [
            params.propertyId.toString(36),
            amount,
            channelAddress,
            payEnabled,
            clearLists,
            isColoredOutput,
        ];
        const type = 4;
        return `${marker}${type.toString(36)}${payload.join(',')}`;
    },

    encodeOnChainTokenForToken(params: {
        propertyIdOffered: number;
        propertyIdDesired: number;
        amountOffered: number;
        amountExpected: number;
        stop: boolean;
        post: boolean;
    }): string {
        const amountOffered = new BigNumber(params.amountOffered).times(1e8).toNumber();
        const amountExpected = new BigNumber(params.amountExpected).times(1e8).toNumber();
        const payload = [
            params.propertyIdOffered.toString(36),
            params.propertyIdDesired.toString(36),
            amountOffered.toString(36),
            amountExpected.toString(36),
            params.stop ? '1' : '0',
            params.post ? '1' : '0',
        ];
        const type = 5;
        return `${marker}${type.toString(36)}${payload.join(',')}`;
    },

    encodeCancelOrder(params: {
        isContract: boolean;
        contractId?: number;
        offeredPropertyId?: number;
        desiredPropertyId?: number;
        cancelAll: boolean;
        cancelParams?: {
            price?: number;
            side?: number;
            txid?: string;
        };
    }): string {
        let encodedTx = params.isContract ? '1' : '0';

        if (params.isContract) {
            encodedTx += `,${params.contractId?.toString(36) ?? ''},${params.cancelAll ? 1 : 0}`;
        } else {
            encodedTx += `,${params.offeredPropertyId?.toString(36) ?? ''},${
                params.desiredPropertyId?.toString(36) ?? ''
            },${params.cancelAll ? 1 : 0}`;
        }

        if (params.cancelParams) {
            if (params.cancelParams.price !== undefined) {
                const priceEncoded = new BigNumber(params.cancelParams.price).times(8).toString(36);
                encodedTx += `,${priceEncoded}`;
                encodedTx += `,${params.cancelParams.side?.toString(36) ?? ''}`;
            }

            if (params.cancelParams.txid) {
                encodedTx += `,${params.cancelParams.txid}`;
            }
        }

        const type = 6;
        return `${marker}${type.toString(36)}${encodedTx}`;
    },

    encodeCreateWhitelist(params: {
        backupAddress: string;
        name: string;
        url: string;
        description: string;
    }): string {
        const payload = [params.backupAddress, params.name, params.url, params.description];
        const type = 7;
        return `${marker}${type.toString(36)}${payload.join(',')}`;
    },

    // Add all remaining methods similarly...
};
