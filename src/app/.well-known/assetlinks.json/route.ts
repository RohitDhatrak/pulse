import { connection } from "next/server";
import { getConfig } from "@/server/config";

/**
 * Digital Asset Links for the Android app (a Trusted Web Activity, e.g. packaged with PWABuilder): it proves this site
 * and the app's signing key belong together, so Android opens the app full screen instead of with a URL bar.
 * 404 until ANDROID_PACKAGE_NAME and ANDROID_CERT_SHA256 are set (docs/pwa.md).
 */
export async function GET() {
  await connection(); // read at request time: the image is built without a .env
  const android = getConfig().android;
  if (!android) return new Response("Not found", { status: 404 });
  return Response.json(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: android.packageName, sha256_cert_fingerprints: android.fingerprints },
      },
    ],
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
