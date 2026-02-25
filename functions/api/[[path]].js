export async function onRequest(context) {
  const backendBase = context.env.VERCEL_BACKEND_URL;
  if (!backendBase) {
    return new Response('Missing VERCEL_BACKEND_URL in Cloudflare Pages environment.', { status: 500 });
  }

  const incomingUrl = new URL(context.request.url);
  const targetUrl = new URL(backendBase);
  targetUrl.pathname = incomingUrl.pathname;
  targetUrl.search = incomingUrl.search;

  const headers = new Headers(context.request.headers);
  headers.set('x-forwarded-host', incomingUrl.host);
  headers.set('x-forwarded-proto', incomingUrl.protocol.replace(':', ''));

  const method = context.request.method.toUpperCase();
  const hasBody = !['GET', 'HEAD'].includes(method);

  const upstreamResp = await fetch(targetUrl.toString(), {
    method,
    headers,
    body: hasBody ? context.request.body : undefined,
    redirect: 'manual',
  });

  const respHeaders = new Headers(upstreamResp.headers);
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });
}
