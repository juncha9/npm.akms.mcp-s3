import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { S3Client } from "@aws-sdk/client-s3";
import { ConfigError, type S3Profile } from "./profile";

interface Clients { read: S3Client; mutate: S3Client; sdk: typeof import("@aws-sdk/client-s3") }

export function createClients(profile: S3Profile) {
    let ca: Buffer | undefined;
    // Preserve startup validation of custom trust files without loading the SDK.
    try { if(profile.caFile) ca = fs.readFileSync(profile.caFile); }
    catch { throw new ConfigError("S3_CA_FILE could not be read."); }
    let closed = false;
    let clients: Clients | undefined;
    let loading: Promise<Clients> | undefined;
    const load = async (): Promise<Clients> => {
        const [sdk, { NodeHttpHandler }, providers] = await Promise.all([
            import("@aws-sdk/client-s3"),
            import("@smithy/node-http-handler"),
            profile.auth === "static" ? undefined : import("@aws-sdk/credential-providers"),
        ]);
        if(closed) throw new DOMException("Server closed", "AbortError");
        const credentials = profile.auth === "static" ? profile.credentials! : profile.auth === "profile" ? providers!.fromIni({ profile: profile.profile }) : providers!.fromNodeProviderChain();
        const create = (maxAttempts: number) => new sdk.S3Client({
            region: profile.region,
            profile: profile.profile,
            credentials,
            endpoint: profile.endpoint,
            ignoreConfiguredEndpointUrls: true,
            forcePathStyle: profile.forcePathStyle,
            useAccelerateEndpoint: false,
            useArnRegion: false,
            useDualstackEndpoint: false,
            useFipsEndpoint: false,
            followRegionRedirects: false,
            maxAttempts,
            requestChecksumCalculation: profile.checksumMode,
            responseChecksumValidation: profile.checksumMode,
            requestHandler: new NodeHttpHandler({
                connectionTimeout: Math.min(profile.limits.requestMs, 10000),
                httpAgent: new http.Agent({ keepAlive: true, maxSockets: profile.limits.concurrency }),
                httpsAgent: new https.Agent({ keepAlive: true, maxSockets: profile.limits.concurrency, ca, rejectUnauthorized: true }),
            }),
            // SDK streaming retry diagnostics can include implementation details; tool errors are sanitized.
            logger: { debug() {}, info() {}, warn() {}, error() {} },
        });
        clients = { read: create(3), mutate: create(1), sdk };
        return clients;
    };
    return {
        get(): Promise<Clients> {
            if(closed) return Promise.reject(new DOMException("Server closed", "AbortError"));
            // Concurrent first requests share client construction and credential providers.
            return loading ??= load().catch(error => { loading = undefined; throw error; });
        },
        close(): void {
            closed = true;
            clients?.read.destroy();
            clients?.mutate.destroy();
            clients = undefined;
            loading = undefined;
            ca = undefined;
        },
    };
}
