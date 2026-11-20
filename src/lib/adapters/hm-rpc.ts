import * as tools from '../tools';
import * as openccuLite from '../openccu-lite';
import type { DetectCallback, DetectOptions, DiscoveryDevice, DiscoveryInstance } from '../types';

/** One interface process of a CCU, as it answers on its classic RPC port */
interface Daemon {
    port: number;
    /** The port the hm-rpc instance listens on for the callbacks */
    callbackPort: number;
    type: 'bin' | 'xml';
    daemon: string;
    title: string;
    comment: string;
    /** `false`: an open port is enough, the process is not asked for its version */
    getVersion: boolean;
}

const DAEMONS: Daemon[] = [
    {
        port: 2000,
        callbackPort: 12000,
        type: 'bin',
        daemon: 'hs485d',
        title: 'HomeMatic hs485d',
        comment: 'hs485d',
        getVersion: true,
    },
    {
        port: 2001,
        callbackPort: 12001,
        type: 'bin',
        daemon: 'rfd',
        title: 'HomeMatic Wireless',
        comment: 'Wireless RF',
        getVersion: true,
    },
    {
        port: 8701,
        callbackPort: 18701,
        type: 'bin',
        daemon: 'CUxD',
        title: 'HomeMatic CuxD',
        comment: 'CUxD',
        getVersion: false,
    },
    {
        port: 2010,
        callbackPort: 12010,
        type: 'xml',
        daemon: 'HMIP',
        title: 'HomeMatic HMIP',
        comment: 'HMIP',
        getVersion: true,
    },
];

/** The `daemon` of an hm-rpc instance in openccu-lite mode */
export const LITE_DAEMON = 'openccu-lite';

/**
 * Budget of the openccu-lite probe, the redirect to HTTPS included. A system answers within
 * 0.1 s; the budget is what a host costs that accepts on port 80 and then says nothing.
 */
const LITE_PROBE_TIMEOUT = 1500;

const PAIRING_HINT =
    'Pair the instance with the system in its settings - the request is approved on the Status page of openccu-lite';
const NO_PAIRING_HINT =
    'Pairing is switched off on this openccu-lite: create a token on its Remote access page and enter it in the instance settings';

/** The openccu-lite probes of one scan, by address; `waiting` while the answer is not in */
interface LiteAnswer {
    system: openccuLite.OpenccuLiteSystem | null;
    waiting: openccuLite.OpenccuLiteCallback[] | null;
}

const scans = new WeakMap<DetectOptions, Map<string, LiteAnswer>>();

/**
 * Whether an address is openccu-lite, asked once per scan.
 *
 * `options` is the scan: hm-rpc and hm-rega both need the answer for the same address, and
 * whichever asks first sends the probe - the other one gets the same answer, also while the
 * probe is still on its way. Nothing depends on the order the two are run in.
 */
export function liteSystem(ip: string, options: DetectOptions, callback: openccuLite.OpenccuLiteCallback): void {
    let scan = scans.get(options);
    if (!scan) {
        scan = new Map();
        scans.set(options, scan);
    }
    const known = scan.get(ip);
    if (known) {
        if (known.waiting) {
            known.waiting.push(callback);
        } else {
            callback(known.system);
        }
        return;
    }
    const answer: LiteAnswer = { system: null, waiting: [callback] };
    scan.set(ip, answer);
    openccuLite.probe(ip, LITE_PROBE_TIMEOUT, (system): void => {
        const waiting = answer.waiting || [];
        answer.system = system;
        answer.waiting = null;
        waiting.forEach(cb => cb(system));
    });
}

function getVersionRequest(ip: string, port: number): string {
    return (
        `POST / HTTP/1.1\r\n` +
        `User-Agent: NodeJS XML-RPC Client\r\n` +
        `Content-Type: text/xml\r\n` +
        `Accept: text/xml\r\n` +
        `Accept-Charset: UTF8\r\n` +
        `Connection: Keep-Alive\r\n` +
        `Content-Length: 98\r\n` +
        `Host: ${ip}:${port}\r\n` +
        `\r\n` +
        `<?xml version="1.0"?><methodCall><methodName>getVersion</methodName><params></params></methodCall>`
    );
}

function isThisHost(instance: DiscoveryInstance, ip: string, device: DiscoveryDevice): boolean {
    return instance.native.homematicAddress === ip || instance.native.homematicAddress === device._name;
}

/** The classic proposals, exactly as before openccu-lite was known */
function proposeClassic(
    ip: string,
    device: DiscoveryDevice,
    name: string,
    open: Daemon[],
    options: DetectOptions,
): boolean {
    let someFound = false;
    for (const d of DAEMONS) {
        if (!open.includes(d)) {
            continue;
        }
        const instance = tools.findInstance(
            options,
            'hm-rpc',
            obj => isThisHost(obj, ip, device) && obj.native.homematicPort === d.port,
        );
        if (instance) {
            continue;
        }
        options.newInstances.push({
            _id: tools.getNextInstanceID('hm-rpc', options),
            common: {
                name: 'hm-rpc',
                title: `${d.title} (${name})`,
            },
            native: {
                homematicAddress: ip,
                adapterAddress: tools.getOwnAddress(ip),
                homematicPort: d.port,
                port: d.callbackPort,
                type: d.type,
                daemon: d.daemon,
            },
            comment: {
                add: [`${d.comment} (${name})`],
            },
        });
        someFound = true;
    }
    return someFound;
}

/**
 * The proposal for an openccu-lite system: one hm-rpc instance in openccu-lite mode, which serves every
 * interface the system runs - never a classic one, those would need `init`, which the system does not
 * forward. Nothing is proposed when an instance in openccu-lite mode for the system exists already, or
 * when the system names no interface at all. The token cannot be discovered: the user pairs the new
 * instance in its settings.
 */
function proposeLite(
    ip: string,
    device: DiscoveryDevice,
    name: string,
    system: openccuLite.OpenccuLiteSystem,
    options: DetectOptions,
): boolean {
    const version = openccuLite.rpcApiVersion(system.info);
    if (version !== undefined && version !== 1) {
        options.log.debug(`openccu-lite at ${ip} speaks lite-rpc ${version}, which hm-rpc does not know yet`);
        return false;
    }

    // the interfaces the version answer names; an older system does not name them
    const named = openccuLite.interfacesOf(system.info);
    if (named?.length === 0) {
        options.log.debug(`openccu-lite at ${ip} runs no interface`);
        return false;
    }
    if (
        tools.findInstance(options, 'hm-rpc', obj => isThisHost(obj, ip, device) && obj.native.daemon === LITE_DAEMON)
    ) {
        return false;
    }

    options.newInstances.push({
        _id: tools.getNextInstanceID('hm-rpc', options),
        common: {
            name: 'hm-rpc',
            title: `HomeMatic openccu-lite (${name})`,
        },
        native: {
            daemon: LITE_DAEMON,
            homematicAddress: ip,
            homematicPort: system.port,
            useHttps: system.https,
            type: 'xml',
        },
        comment: {
            add: [named ? `${named.join(', ')} (openccu-lite, ${name})` : `openccu-lite (${name})`],
            text: openccuLite.pairingAllowed(system.info) ? PAIRING_HINT : NO_PAIRING_HINT,
        },
    });
    return true;
}

export function detect(ip: string, device: DiscoveryDevice, options: DetectOptions, callback: DetectCallback): void {
    // The classic RPC ports and openccu-lite's version answer are asked at the same time, and
    // nothing is proposed before both are in: an openccu-lite with classic RPC switched on
    // answers on the classic ports too, and must not get the classic proposals.
    const name = ip + (device._name && device._name !== ip ? ` - ${device._name}` : '');
    const open: Daemon[] = [];
    let system: openccuLite.OpenccuLiteSystem | null = null;
    let count = DAEMONS.length + 1;

    const settle = (): void => {
        if (--count) {
            return;
        }
        const found = system
            ? proposeLite(ip, device, name, system, options)
            : proposeClassic(ip, device, name, open, options);
        callback(null, found, ip);
    };

    for (const d of DAEMONS) {
        const onResult = (_err: unknown, found: boolean): void => {
            if (found) {
                open.push(d);
            }
            settle();
        };
        if (d.getVersion) {
            tools.testPort(
                ip,
                d.port,
                {
                    onConnect: (ip, port, client): void => {
                        client.write(getVersionRequest(ip, port));
                    },
                    onReceive: data => data && !!data.toString().match(/<value>[.\d]+<\/value>/),
                },
                onResult,
            );
        } else {
            tools.testPort(ip, d.port, onResult);
        }
    }

    liteSystem(ip, options, (result): void => {
        system = result;
        settle();
    });
}

export const type = ['ip']; // make type=serial for USB sticks
// The openccu-lite probe may take its whole budget - a redirect and a TLS handshake with a Pi.
// With it this is the 2 s every module without a timeout of its own gets.
export const timeout = LITE_PROBE_TIMEOUT + 500;
