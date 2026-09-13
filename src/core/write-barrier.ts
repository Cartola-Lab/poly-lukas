import type { Wallet, providers } from 'ethers';
import type { ClobClient } from '@polymarket/clob-client-v2';
import { executionMode } from './execution-mode.js';

const wallets = new WeakSet<Wallet>();
const providersGuarded = new WeakSet<providers.Provider>();
const clients = new WeakSet<ClobClient>();

/**
 * Guard the final JSON-RPC submission, after ethers' asynchronous population and
 * signing. Also covers raw sends through OnchainService.getProvider(). Reads and
 * eth_call/estimateGas are unchanged. Runtime writers use JsonRpcProvider (or its
 * Static variant); unsupported transports must not silently become a bypass.
 */
export function protectProvider<T extends providers.Provider>(provider: T): T {
  if (providersGuarded.has(provider)) return provider;
  const rpc = provider as T & { send(method: string, params: unknown[]): Promise<unknown> };
  if (typeof rpc.send !== 'function') {
    throw new Error('Write barrier requires a JSON-RPC provider with send().');
  }
  const send = rpc.send;
  rpc.send = async function (method, params) {
    if (method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction') {
      executionMode.assertCanWrite(`RPC ${method}`);
    }
    return send.call(this, method, params);
  };
  providersGuarded.add(provider);
  return provider;
}

/** Covers contracts, direct wallet sends and wallets returned by connect(). */
export function protectWallet<T extends Wallet>(wallet: T): T {
  if (wallets.has(wallet)) return wallet;
  if (wallet.provider) protectProvider(wallet.provider);
  const sendTransaction = wallet.sendTransaction;
  wallet.sendTransaction = async function (transaction) {
    executionMode.assertCanWrite('Wallet.sendTransaction');
    return sendTransaction.call(this, transaction);
  };
  const signTransaction = wallet.signTransaction;
  wallet.signTransaction = async function (transaction) {
    executionMode.assertCanWrite('Wallet.signTransaction');
    return signTransaction.call(this, transaction);
  };
  const connect = wallet.connect;
  wallet.connect = function (provider) {
    return protectWallet(connect.call(this, provider));
  };
  wallets.add(wallet);
  return wallet;
}

/**
 * clob-client-v2 1.1.0's createAndPost methods await signing/auth before calling the
 * HTTP post method. Guard that final boundary too, not just strategy entry.
 * The narrow internal transport seam is covered by tests against the real SDK.
 * API-key setup and read requests do not change economic exposure.
 */
export function protectClobClient(client: ClobClient): ClobClient {
  if (clients.has(client)) return client;
  const transport = client as unknown as {
    post(url: string, options?: unknown, skipThrow?: boolean): Promise<unknown>;
    del(url: string, options?: unknown, skipThrow?: boolean): Promise<unknown>;
  };
  if (typeof transport.post !== 'function' || typeof transport.del !== 'function') {
    throw new Error('Unsupported CLOB client: missing guarded POST/DELETE transport.');
  }
  const post = transport.post;
  transport.post = async function (url, options, skipThrow) {
    const path = new URL(url).pathname.replace(/\/$/, '');
    if (path === '/order' || path === '/orders' || path.startsWith('/rfq/') || path === '/v1/heartbeats') {
      executionMode.assertCanWrite(`CLOB POST ${path}`);
    }
    return post.call(this, url, options, skipThrow);
  };
  const del = transport.del;
  transport.del = async function (url, options, skipThrow) {
    // All SDK DELETE routes mutate remote state, including order/RFQ cancels,
    // notification deletion and API-key revocation. No HALT exception here.
    executionMode.assertCanWrite(`CLOB DELETE ${new URL(url).pathname}`);
    return del.call(this, url, options, skipThrow);
  };
  // V2 1.1.0 has no RFQ client or separately captured RFQ transports.
  clients.add(client);
  return client;
}
