import { appendFileSync } from 'fs';
import * as moment from 'moment';

export enum ELogType {
    PUBKEYS = 'PUBKEYS',
    TXIDS = 'TXIDS',
};

export const saveLog = (type: ELogType, data: string) => {
    try {
        const time = Date.now();
        const date = moment().format('DD-MM-YYYY');
        const name = `${type}_${date}`;
        const line = `${time}-${data}\n`;
        appendFileSync(`logs/${name}.log`, line);
    } catch (error) {
        console.log(error);
    }
};
