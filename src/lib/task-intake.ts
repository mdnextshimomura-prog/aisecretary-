/**
 * 新規タスク受付の入口判定。
 *
 * LINEグループの通常会話をAIが拾わないよう、新規受付はAI秘書への
 * 明示メンションを必須にする。社員へのメンションは担当指定としてだけ使う。
 */
export interface MentioneeLike {
  type: "user" | "all";
  userId?: string;
}

export function taskMentionState(
  mentionees: MentioneeLike[] | undefined,
  botUserId: string | undefined
): {
  mentionsBot: boolean;
  mentionsAssignee: boolean;
} {
  const list = mentionees ?? [];
  const mentionsBot = Boolean(
    botUserId &&
      list.some((m) => m.type === "user" && m.userId === botUserId)
  );
  const mentionsAssignee = list.some(
    (m) => m.type === "user" && m.userId !== botUserId
  );
  return { mentionsBot, mentionsAssignee };
}

/**
 * 「お願いします」だけで対象も作業も分からない依頼か。
 * 添付がある場合は添付が依頼内容なので、呼び出し側でこの判定を使わない。
 */
export function isContextlessRequest(text: string): boolean {
  const t = (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000。、,.!！?？「」『』（）()]/g, "");
  if (!t) return true;
  return /^(これ|こちら|この件)?(の)?(対応)?(を)?(お願い(します|いたします|できますか)?|よろしく(お願い(します|いたします)?)?)$/.test(
    t
  );
}
