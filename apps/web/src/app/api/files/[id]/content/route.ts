import { authenticate } from "@/server/auth/principal";
import { json, route } from "@/server/http";
import { uploadFileContent } from "@/server/services/captures";

// raw request body is streamed to storage — never buffered or size-limited like Server Actions
export const runtime = "nodejs";
export const maxDuration = 300;

/** Step 2 of the capture upload protocol: PUT the original bytes. */
export const PUT = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const principal = await authenticate(req, { allowDevice: true });
  const { id } = await params;
  return json(await uploadFileContent(principal, id, req.body));
});
