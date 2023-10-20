import { SuiClient, getFullnodeUrl } from '@mysten/sui.js/client';
import { SerializedSignature } from '@mysten/sui.js/cryptography';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import {
    genAddressSeed,
    generateNonce,
    generateRandomness,
    getZkLoginSignature,
    jwtToAddress,
} from '@mysten/zklogin';
import { toBigIntBE } from 'bigint-buffer';
import { decodeJwt } from 'jose';
import { useEffect, useState } from 'react';
import './App.less';
import config from './config.json';

const NETWORK = 'devnet';
const MAX_EPOCH = 2; // keep ephemeral keys active for this many Sui epochs from now (1 epoch ~= 24h)

const suiClient = new SuiClient({
    url: getFullnodeUrl(NETWORK),
});

/* Local storage keys */

const setupDataKey = 'zklogin-demo.setup';
const accountDataKey = 'zklogin-demo.accounts';

/* Types */

type OpenIdProvider = 'google' | 'twitch' | 'facebook';

type SetupData = {
    provider: OpenIdProvider,
    maxEpoch: number;
    randomness: string;
    ephemeralPublicKey: string,
    ephemeralPrivateKey: string,
}

type AccountData = {
    provider: OpenIdProvider;
    userAddr: string;
    zkProofs: any; // TODO: add type
    ephemeralPublicKey: string;
    ephemeralPrivateKey: string;
    userSalt: string;
    sub: string;
    aud: string;
    maxEpoch: number;
}

export const App: React.FC = () =>
{
    const [accounts, setAccounts] = useState<AccountData[]>(loadAccounts());
    const [balances, setBalances] = useState<Map<string, number>>(new Map()); // Map<Sui address, SUI balance>

    useEffect(() => {
        completeZkLogin();

        fetchBalances(accounts);
        const interval = setInterval(() => fetchBalances(accounts), 6_000);
        return () => clearInterval(interval);
    }, []);

    /* zkLogin logic */

    async function beginZkLogin(provider: OpenIdProvider) {
        // Create a nonce
        // https://docs.sui.io/build/zk_login#set-up-oauth-flow
        const { epoch } = await suiClient.getLatestSuiSystemState();
        const maxEpoch = Number(epoch) + MAX_EPOCH; // the ephemeral key will be valid for MAX_EPOCH from now
        const randomness = generateRandomness();
        const ephemeralKeyPair = new Ed25519Keypair();
        const nonce = generateNonce(ephemeralKeyPair.getPublicKey(), maxEpoch, randomness);

        // Save data to local storage so completeZkLogin() can use it after the redirect
        saveSetupData({
            provider,
            maxEpoch,
            randomness: randomness.toString(),
            ephemeralPublicKey: toBigIntBE(Buffer.from(ephemeralKeyPair.getPublicKey().toSuiBytes())).toString(),
            ephemeralPrivateKey: ephemeralKeyPair.export().privateKey,
        });

        // Start the OAuth flow with the OpenID provider
        // https://docs.sui.io/build/zk_login#configure-a-developer-account-with-openid-provider
        const urlParamsBase = {
            nonce: nonce,
            redirect_uri: window.location.origin,
            response_type: 'id_token',
            scope: 'openid',
        };
        let loginUrl: string;
        switch (provider) {
            case 'google': {
                const urlParams = new URLSearchParams({
                    ...urlParamsBase,
                    client_id: config.CLIENT_ID_GOOGLE,
                });
                loginUrl = `https://accounts.google.com/o/oauth2/v2/auth?${urlParams}`;
                break;
            }
            case 'twitch': {
                const urlParams = new URLSearchParams({
                    ...urlParamsBase,
                    client_id: config.CLIENT_ID_TWITCH,
                    force_verify: 'true',
                    lang: 'en',
                    login_type: 'login',
                });
                loginUrl = `https://id.twitch.tv/oauth2/authorize?${urlParams}`;
                break;
            }
            case 'facebook': {
                const urlParams = new URLSearchParams({
                    ...urlParamsBase,
                    client_id: config.CLIENT_ID_FACEBOOK,
                });
                loginUrl = `https://www.facebook.com/v18.0/dialog/oauth?${urlParams}`;
                break;
            }
        }
        window.location.replace(loginUrl);
    }

    async function completeZkLogin() {
        // Validate the JWT
        const urlFragment = window.location.hash.substring(1);
        const urlParams = new URLSearchParams(urlFragment);
        const jwt = urlParams.get('id_token');
        if (!jwt) {
            return;
        }
        window.history.replaceState(null, '', window.location.pathname); // remove URL fragment
        const jwtPayload = decodeJwt(jwt);
        if (!jwtPayload.sub || !jwtPayload.aud) {
            console.warn('[completeZkLogin] missing jwt.sub or jwt.aud');
            return;
        }

        // Get a Sui address for the user
        // https://docs.sui.io/build/zk_login#get-the-users-sui-address
        const saltResponse: any = await fetch(config.URL_SALT_SERVICE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jwt }),
        })
        .then(res => {
            return res.json();
        })
        .catch(error => {
            console.warn('[completeZkLogin] failed to get user salt:', error);
            return null;
        });
        if (!saltResponse) {
            return;
        }
        const userSalt = BigInt(saltResponse.salt);
        const userAddr = jwtToAddress(jwt, userSalt);

        // Load and clear data from local storage which beginZkLogin() created before the redirect
        const setupData = loadSetupData();
        if (!setupData) {
            console.warn('[completeZkLogin] missing local storage data');
            return;
        }
        clearSetupData();
        for (const account of accounts) {
            if (userAddr === account.userAddr) {
                console.warn(`[completeZkLogin] already logged in with this ${setupData.provider} account`);
                return;
            }
        }

        // Get the zero-knowledge proof
        // https://docs.sui.io/build/zk_login#get-the-zero-knowledge-proof
        const payload = JSON.stringify({
            maxEpoch: setupData.maxEpoch,
            jwtRandomness: setupData.randomness,
            extendedEphemeralPublicKey: setupData.ephemeralPublicKey,
            jwt,
            salt: userSalt.toString(),
            keyClaimName: 'sub',
        }, null, 2);
        console.debug('[completeZkLogin] Requesting ZK proof with:', payload);
        const zkProofs = await fetch(config.URL_ZK_PROVER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        })
        .then(res => {
            return res.json();
        })
        .catch(error => {
            console.warn('[completeZkLogin] failed to get ZK proof:', error);
            return null;
        });

        if (!zkProofs) {
            return;
        }

        // Save data to local storage so submitTransaction() can use it
        saveAccount({
            provider: setupData.provider,
            userAddr,
            zkProofs,
            ephemeralPublicKey: setupData.ephemeralPublicKey,
            ephemeralPrivateKey: setupData.ephemeralPrivateKey,
            userSalt: userSalt.toString(),
            sub: jwtPayload.sub,
            aud: typeof jwtPayload.aud === 'string' ? jwtPayload.aud : jwtPayload.aud[0],
            maxEpoch: setupData.maxEpoch,
        });
    }

    // Assemble the zkLogin signature and submit the transaction
    // https://docs.sui.io/build/zk_login#assemble-the-zklogin-signature-and-submit-the-transaction
    async function submitTransaction(account: AccountData) {
        // Sign the transaction bytes with the ephemeral private key.
        const txb = new TransactionBlock();
        txb.setSender(account.userAddr);
        const ephemeralKeyPair = Ed25519Keypair.fromSecretKey(
            Buffer.from(account.ephemeralPrivateKey, 'base64')
        );
        const { bytes, signature: userSignature } = await txb.sign({
            client: suiClient,
            signer: ephemeralKeyPair,
        });

        // Generate an address seed by combining userSalt, sub (subject ID), and aud (audience).
        const addressSeed = genAddressSeed(
            BigInt(account.userSalt),
            'sub',
            account.sub,
            account.aud,
        ).toString();

        // Serialize the zkLogin signature by combining the ZK proof (inputs), the maxEpoch,
        // and the ephemeral signature (userSignature).
        const zkLoginSignature : SerializedSignature = getZkLoginSignature({
            inputs: {
                ...account.zkProofs,
                addressSeed,
            },
            maxEpoch: account.maxEpoch,
            userSignature,
        });

        // Execute the transaction
        const result = await suiClient.executeTransactionBlock({
            transactionBlock: bytes,
            signature: zkLoginSignature,
        });
        console.debug(result);
    }

    // Get the SUI balance for each account
    async function fetchBalances(accounts: AccountData[]) {
        if (accounts.length == 0) {
            return;
        }
        const newBalances: Map<string, number> = new Map();
        for (const account of accounts) {
            const suiBalance = await suiClient.getBalance({
                owner: account.userAddr,
                coinType: '0x2::sui::SUI',
            });
            newBalances.set(account.userAddr, +suiBalance.totalBalance/1_000_000_000);
        }
        setBalances(newBalances);
    }

    /* Local storage + React state */

    function saveSetupData(data: SetupData) {
        localStorage.setItem(setupDataKey, JSON.stringify(data))
    }

    function loadSetupData(): SetupData|null {
        const dataRaw = localStorage.getItem(setupDataKey);
        if (!dataRaw) {
            return null;
        }
        const data: SetupData = JSON.parse(dataRaw);
        return data;
    }

    function clearSetupData(): void {
        localStorage.removeItem(setupDataKey);
    }

    function saveAccount(account: AccountData): void {
        const newAccounts = [account, ...accounts];
        localStorage.setItem(accountDataKey, JSON.stringify(newAccounts));
        setAccounts(newAccounts);
        fetchBalances([account]);
    }

    function loadAccounts(): AccountData[] {
        const dataRaw = localStorage.getItem(accountDataKey);
        if (!dataRaw) {
            return [];
        }
        const data: AccountData[] = JSON.parse(dataRaw);
        return data;
    }

    /* HTML */

    const openIdProviders: OpenIdProvider[] = ['google', 'twitch', 'facebook'];
    return (
    <div id='page'>
        <div id='network-indicator'>
            <label>{NETWORK}</label>
        </div>
        <h1>Sui zkLogin demo</h1>
        <div id='login-buttons' className='section'>
            <h2>Log in:</h2>
            {openIdProviders.map(provider =>
                <button
                    className={`btn-login ${provider}`}
                    onClick={() => beginZkLogin(provider)}
                    key={provider}
                >
                    {provider}
                </button>
            )}
        </div>
        <div id='accounts' className='section'>
            <h2>Accounts:</h2>
            {accounts.map(acct => {
                const balance = balances.get(acct.userAddr);
                return (
                <div className='account' key={acct.userAddr}>
                    <div>
                        <label className={`provider ${acct.provider}`}>{acct.provider}</label>
                    </div>
                    <div>Address: {shortenAddress(acct.userAddr)}</div>
                    <div>User ID: {acct.sub}</div>
                    <div>Balance: {balance}</div>
                    <button
                        className={`btn-send ${!balance ? 'disabled' : ''}`}
                        disabled={!balance}
                        onClick={() => submitTransaction(acct)}
                    >
                        Send transaction
                    </button>
                    <hr/>
                </div>
                );
            })}
        </div>
    </div>
    );
}

function shortenAddress(address: string): string {
    return '0x' + address.slice(2, 8) + '...' + address.slice(-6);
}
