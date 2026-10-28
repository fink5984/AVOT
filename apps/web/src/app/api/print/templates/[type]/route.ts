import { LABEL_TYPES, type LabelType } from "@avot/shared";
import { authenticateUser } from "@/server/auth/principal";
import { notFound } from "@/server/errors";
import { json, parseJson, route } from "@/server/http";
import { resetLabelTemplate, saveLabelTemplate, saveTemplateSchema } from "@/server/services/label-templates";

type Ctx = { params: Promise<{ type: string }> };
const typeOf = async (ctx: Ctx): Promise<LabelType> => {
  const t = (await ctx.params).type.toUpperCase();
  if (!(LABEL_TYPES as readonly string[]).includes(t)) throw notFound("סוג התווית");
  return t as LabelType;
};

export const PUT = route<Ctx>(async (req, ctx) => {
  const user = await authenticateUser(req, "print.manage");
  return json({ profile: await saveLabelTemplate(user, await typeOf(ctx), await parseJson(req, saveTemplateSchema)) });
});

/** back to the professional defaults */
export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await authenticateUser(req, "print.manage");
  return json({ profile: await resetLabelTemplate(user, await typeOf(ctx)) });
});
