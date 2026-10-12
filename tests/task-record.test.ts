import {
  assigneeUserProps,
  dealLinkProps,
  enrichTask,
  matchDeals,
  originProps,
  type DealRef,
  type RecordDeps,
  type RecordInfo,
} from "../src/lib/task-record";
import { normalizeProperty } from "../src/lib/property";

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} → ${JSON.stringify(a)}`);
  }
};

// 架空の案件
const deals: DealRef[] = [
  { id: "d1", name: "サンプルハイツ梅田｜売買仲介" },
  { id: "d2", name: "売却相談｜架空 太郎｜テストコート北浜 305" },
  { id: "d3", name: "テストコート北浜 1201｜売買仲介" },
  { id: "d4", name: "架空マンション東｜買取再販" },
  { id: "d5", name: "架空マンション東｜売買仲介" },
];
const key = (s: string) => normalizeProperty(s);

eq("物件の鍵が無い → 案件なし", matchDeals(null, deals), { state: "案件なし", dealId: null, names: [] });
eq("完全一致が 1 件 → その案件を候補に入れる", matchDeals(key("サンプルハイツ梅田"), deals), {
  state: "候補あり",
  dealId: "d1",
  names: ["サンプルハイツ梅田｜売買仲介"],
});
eq(
  "表記ゆれ（全角・空白）があっても同じ鍵で当たる",
  matchDeals(key("ｻﾝﾌﾟﾙﾊｲﾂ　梅田"), deals).dealId,
  "d1"
);
eq(
  "完全一致が複数（仕入と再販など）→ 選ばない。名前だけ控える",
  matchDeals(key("架空マンション東"), deals),
  {
    state: "候補あり",
    dealId: null,
    names: ["架空マンション東｜買取再販", "架空マンション東｜売買仲介"],
  }
);
eq(
  "部分一致だけ（同じ建物の別の部屋）→ 選ばない。名前だけ控える",
  matchDeals(key("テストコート北浜"), deals),
  {
    state: "候補あり",
    dealId: null,
    names: ["売却相談｜架空 太郎｜テストコート北浜 305", "テストコート北浜 1201｜売買仲介"],
  }
);
eq("当たらない → 未割当", matchDeals(key("どこにも無い物件"), deals), { state: "未割当", dealId: null, names: [] });
eq("短い鍵は部分一致に使わない", matchDeals(key("梅田"), deals).state, "未割当");
eq(
  "候補の名前は 5 件まで",
  matchDeals(
    key("量産物件"),
    Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, name: `量産物件 ${i}号室｜売買仲介` }))
  ).names.length,
  5
);

const info: RecordInfo = {
  requester: "架空 花子",
  requesterId: "U_REQ",
  groupId: "G_MAIN",
  assigneeNotionUserId: "nu-1",
  propertyKey: key("サンプルハイツ梅田"),
};
eq("頼んだ人・発生元の欄", originProps(info), {
  依頼者: { rich_text: [{ text: { content: "架空 花子" } }] },
  依頼者ID: { rich_text: [{ text: { content: "U_REQ" } }] },
  発生元: { rich_text: [{ text: { content: "G_MAIN" } }] },
});
eq("分からない項目は書かない", originProps({ ...info, requester: null, requesterId: null, groupId: null }), {});
eq("担当のユーザー", assigneeUserProps("nu-1"), { "担当（ユーザー）": { people: [{ id: "nu-1" }] } });
eq("担当のユーザーを空にする", assigneeUserProps(null), { "担当（ユーザー）": { people: [] } });
eq("案件（1 件に絞れたとき）", dealLinkProps({ state: "候補あり", dealId: "d1", names: [] }), {
  案件の状態: { select: { name: "候補あり" } },
  案件: { relation: [{ id: "d1" }] },
});
eq("絞れないときは状態だけ", dealLinkProps({ state: "未割当", dealId: null, names: [] }), {
  案件の状態: { select: { name: "未割当" } },
});

function fake(opts: { failOn?: (props: Record<string, unknown>) => boolean; dealsFail?: boolean } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const warns: string[] = [];
  const deps: RecordDeps = {
    loadDeals: async () => {
      if (opts.dealsFail) throw new Error("no access");
      return deals;
    },
    update: async (_id, props) => {
      if (opts.failOn?.(props)) throw new Error("notion");
      updates.push(props);
    },
    note: async (_id, line) => {
      notes.push(line);
    },
    warn: (s) => warns.push(s),
  };
  return { deps, updates, notes, warns };
}

(async () => {
  {
    const f = fake();
    const r = await enrichTask("p1", info, f.deps);
    eq("全部書ける", r, { origin: true, assignee: true, deal: "候補あり" });
    eq("3 回に分けて書く（1 つの失敗で他を巻き込まない）", f.updates.length, 3);
    eq("1 件に絞れたら本文への控えは要らない", f.notes, []);
  }
  {
    const f = fake();
    await enrichTask("p1", { ...info, propertyKey: key("テストコート北浜") }, f.deps);
    eq("絞れない候補は、名前を本文に控える", f.notes.length === 1 && f.notes[0].includes("テストコート北浜 1201"), true);
  }
  {
    // ユーザーの欄に書けない（権限なし）
    const f = fake({ failOn: (p) => "担当（ユーザー）" in p });
    const r = await enrichTask("p1", info, f.deps);
    eq("担当のユーザーに書けなくても、他は書く", [r, f.warns], [{ origin: true, assignee: false, deal: "候補あり" }, ["assignee"]]);
  }
  {
    // 案件の欄に書けない（案件の DB が共有されていない）
    const f = fake({ failOn: (p) => "案件" in p });
    const r = await enrichTask("p1", info, f.deps);
    eq("案件に書けなければ、状態だけ残す", [r.deal, f.warns], ["候補あり", ["deal-link"]]);
    eq(
      "案件に書けなかったときは、絞れた 1 件の名前を本文に控える（人が選べるように）",
      f.notes.length === 1 && f.notes[0].includes("サンプルハイツ梅田"),
      true,
    );
  }
  {
    const f = fake({ dealsFail: true });
    const r = await enrichTask("p1", info, f.deps);
    eq("案件を読めないときは、状態を決めない", [r, f.warns], [{ origin: true, assignee: true, deal: "failed" }, ["deal-load"]]);
  }
  {
    const f = fake({ failOn: () => true });
    const r = await enrichTask("p1", info, f.deps);
    eq("全部失敗しても例外を投げない", r, { origin: false, assignee: false, deal: "failed" });
  }
  {
    const f = fake();
    const r = await enrichTask("p1", { requester: null, requesterId: null, groupId: null, assigneeNotionUserId: null, propertyKey: null }, f.deps);
    eq("何も分からないタスクは「案件なし」だけ書く", [r, f.updates], [{ origin: false, assignee: false, deal: "案件なし" }, [{ 案件の状態: { select: { name: "案件なし" } } }]]);
  }
  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})();
