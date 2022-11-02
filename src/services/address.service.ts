import { envConfig } from "../config/env.config";
import { rpcClient } from "../config/rpc.config"

export const validateAddress = async (address:string) => {
    const res = await rpcClient.call('validateaddress', address);
    return res;
}

export const getAddressBalance = async (address: string) => {
    const res = await rpcClient.call('tl_getallbalancesforaddress', address);
    return res;
}

export const fundAddress = async (address: string) => {
    const network = envConfig.NETWORK;
    if (network.endsWith("TEST")) {
        const res = await rpcClient.call('sendtoaddress', address, 1);
        return res;
    }
    return { error: 'Faucet is Allowed only in TESTNET' };
}

export const getAttestationPayload = async (ip: string, server: any) => {
    try {
        if (!ip) throw new Error("Cant Detect Location");
        const isSafeVpnRes = await checkVPN(ip, server.axios);
        if (isSafeVpnRes.error) throw new Error(`VPN Check Error: ${isSafeVpnRes.error}`);
        if (isSafeVpnRes.data === true) {
            const url = `http://www.geoplugin.net/json.gp?ip=${ip}`;
            const { data, error } = await server.axios.get(url);
            if (!data || error) throw new Error(error);
            const { geoplugin_status, geoplugin_countryCode } = data;
            if (!geoplugin_countryCode) throw new Error(`Status Code: ${geoplugin_status}`);
            const payloadRes = await rpcClient.call('tl_createpayload_attestation', geoplugin_countryCode);
            return payloadRes;
        } else {
            throw new Error("VPN Check Undefined Error");
        }
    } catch (error: any) {
        return { error: error.message };
    }
}

const checkVPN = async (ip: string, axios: any) => {
    try {
        const KEYS = envConfig.VPN_KEYS;
        const vpnCheckConf = [
            {
                url: `http://v2.api.iphub.info/ip/${ip}`,
                headers: { "X-Key": KEYS.VPN_IPHUB },
                isSafe: (data: any) => data.block === 0,
                isVPN: (data: any) => data.block === 1 || data.block === 2,
            },
            // {
            //     url: `http://ipinfo.io/${ip}`,
            //     params: { "token": KEYS.VPN_IPINFO },
            // },
            {
                url: `https://www.iphunter.info:8082/v1/ip/${ip}`,
                headers: { "X-Key": KEYS.VPN_IPHUNTER },
                isSafe: (data: any) => data.data?.block === 0,
                isVPN: (data: any) => data.block === 1 || data.block === 2,

            },
            {
                url: `https://vpnapi.io/api/${ip}`,
                params: { "key": KEYS.VPN_VPNAPI },
                isSafe: (data: any) => (
                    data.security?.vpn === false &&
                    data.security?.proxy === false &&
                    data.security?.tor === false &&
                    data.security?.relay === false
                ),
                isVPN: (data: any) => (
                    data.security?.vpn === true ||
                    data.security?.proxy === true ||
                    data.security?.tor === true ||
                    data.security?.relay === true
                ),
            },
            {
                url: `https://api.criminalip.io/v1/ip/vpn`,
                headers: { "x-api-key": KEYS.VPN_CRIMINALIP },
                params: { ip },
                isSafe: (data: any) => (data.is_vpn === false && data.is_tor === false && data.is_proxy === false),
                isVPN: (data: any) => (data.is_vpn === true || data.is_tor === true || data.is_proxy === true),

            },
        ];
        let isSafe = false;
        let isVpn = false;
        for (let i = 0; i < vpnCheckConf.length; i++) {
            if (isSafe || isVpn) break;
            const vpnObj = vpnCheckConf[i];
            const config: any = {};
            if (vpnObj.params) config.params = vpnObj.params;
            if (vpnObj.headers) config.headers = vpnObj.headers;
            await axios.get(vpnObj.url, config)
                .then((res: any) => {
                    const _isVpn = vpnObj.isVPN(res.data);
                    if (_isVpn) isVpn = true;
                    const _isSafe = vpnObj.isSafe(res.data);
                    if (_isSafe) isSafe = true;
                })
                .catch((err: any) => console.log(err.message));
        };
        if (!isSafe || isVpn) throw new Error('VPN is not Allowed.Please make sure your VPN is turned Off');
        return { data: isSafe };
    } catch (error: any) {
        return { error: error.message };
    }
}