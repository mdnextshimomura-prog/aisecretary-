import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "MD NEXT秘書 — 機能ガイド",
  description:
    "LINEで話しかけるだけで、メール作成・送信、タスク登録、顧客(CRM)登録ができるAI秘書の社内向け機能ガイド。",
};

/* =========================================================================
 * このページは「機能ガイドLP」です。機能が増えたら、下の FEATURES 配列に
 * 1オブジェクト追加するだけで、上部ナビ・目次カード・本文セクションの
 * すべてに自動で反映されます（手作業でのHTML追記は不要）。
 *
 *   新機能の追加手順:
 *   1) FEATURES に { id, tag, tint, title, ... } を1件足す
 *   2) 必要なら chat（トーク例）と mechanism（裏側の仕組み）を書く
 *   → ナビのリンク・目次カード・セクションが自動生成されます
 * ========================================================================= */

type ChatMsg = {
  side: "in" | "out";
  time?: string;
  file?: boolean; // ファイル/画像の吹き出し（薄色表示）
  menu?: boolean; // 確認メニュー（点線枠）
  head?: string; // 太字の見出し行
  body?: string; // 本文（改行は \n）
  foot?: string; // 補足（薄色）
};

type Feature = {
  id: string; // アンカーID（URL の #id）
  tag: string; // 種別ラベル（Mail / Task / CRM ...）
  tint: string; // アクセント色のCSS変数名
  title: string;
  sub: string;
  card: string; // 目次カードの短い説明
  says?: { label: string; text: string }[]; // 「こう話しかける」例
  points?: { b: string; rest: string }[]; // ポイント（太字リード + 説明）
  mechanism?: { title: string; body: string; link?: { href: string; label: string } };
  note?: string;
  chat: ChatMsg[];
  chatCap: string;
  reversed?: boolean;
};

const FEATURES: Feature[] = [
  {
    id: "email",
    tag: "Mail",
    tint: "--t-mail",
    title: "メールを作って送る",
    card: "「◯◯さんにメール送って」で下書き作成 →「送信」で確定。",
    sub: "「メール送って」と伝えるだけ。宛名・名乗り・本文・署名まで整えた下書きを出し、あなたが「送信」と返して初めて送られます。",
    says: [
      {
        label: "例1・ふつうに依頼",
        text: "田中不動産の田中さんに、来週の内見日程の件でメール送っておいて",
      },
      {
        label: "例2・差出人を指定",
        text: "会社のアドレスから、社長名義でお礼のメールを送って",
      },
    ],
    points: [
      {
        b: "宛名と名乗りが自動で入る。",
        rest: "「◯◯株式会社／役職 氏名 様」で始まり、本文で「MD NEXT株式会社の◯◯と申します」と名乗ります。",
      },
      {
        b: "差出人を選べる。",
        rest: "会社・自分・社長など、登録済みのアドレスと署名を使い分け。「山口から送る」のように名前だけ差し込むことも可能。",
      },
      {
        b: "送る前に必ず確認。",
        rest: "下書きを見て、直したければ修正内容を返信、良ければ「送信」。勝手には送りません。",
      },
    ],
    mechanism: {
      title: "裏側の仕組み — Gmailと連携",
      body: "会社のGmailと安全に接続して送信します。差出人アカウントと署名はあなたの指定で切り替え。文面はAIがビジネスメールとして自然な形に整え、宛名・署名はシステムが機械的に付けるので抜けません。",
    },
    note: "「もっと丁寧にして送って」のように修正指示が混ざっていると、送信せずに直した下書きを出し直します。",
    chat: [
      {
        side: "out",
        time: "9:41",
        body: "田中不動産の田中さんに、来週の内見日程の件でメール送っておいて",
      },
      {
        side: "in",
        head: "✉️ メール下書きを作成しました。ご確認ください。",
        body: "👤 差出人：下村 亮太\n📮 宛先：田中 様 <tanaka@…>\n件名：内見日程のご相談\n――――――――\n田中不動産株式会社\n田中 様\n\nお世話になっております。\nMD NEXT株式会社の下村と申します。\n\n来週の内見の日程について、ご相談させていただきたくご連絡いたしました。ご都合のよい候補日をお知らせいただけますと幸いです。\n\nよろしくお願いいたします。\n■□■□ …（署名）\n――――――――",
        foot: "▶ 送信するには「送信」、直す場合は修正内容を返信。",
      },
      { side: "out", time: "9:42", body: "送信" },
      {
        side: "in",
        head: "📧 送信しました。",
        body: "宛先：田中 様 <tanaka@…>\n件名：内見日程のご相談",
      },
    ],
    chatCap: "発言 → 下書き確認 → 「送信」で確定",
  },
  {
    id: "card",
    tag: "Card",
    tint: "--t-card",
    title: "名刺から宛先を読む・資料を添付する",
    card: "名刺の写真/PDFを送って「この方に送って」。宛先入力は不要。",
    sub: "名刺の写真やPDFを送っておき、「この名刺の方に送って」と言うだけ。宛先の入力は不要です。資料PDFも一緒に添付できます。",
    reversed: true,
    points: [
      { b: "名刺（写真 or PDF）を送る", rest: "→ 秘書は黙って控えます（毎回は反応しません）。" },
      { b: "資料PDFも送る", rest: "続けて送るだけ。" },
      { b: "「この名刺の方に、この資料を送って」", rest: "と伝えると下書きが出ます。" },
    ],
    mechanism: {
      title: "裏側の仕組み — 画像・PDFをAIが読み取り",
      body: "名刺の画像やPDFをAIが解析し、会社名・屋号・役職・氏名・メールアドレスを抽出して宛先と宛名に反映します。指示に「資料」「添付」などがあれば、直前のPDFを自動で添付します。",
    },
    note: "関係のない画像やPDFには勝手に反応しません。メールの指示が来たときだけ名刺として読み取ります。1対1のトークでも使えます。",
    chat: [
      { side: "out", time: "10:03", file: true, body: "🖼 名刺.jpg" },
      { side: "out", time: "10:03", file: true, body: "📄 物件資料.pdf" },
      { side: "out", time: "10:04", body: "この名刺の方に、この資料を送っておいて" },
      {
        side: "in",
        head: "✉️ メール下書きを作成しました。",
        body: "📮 宛先：山田 様 <yamada@…>\n📎 添付：物件資料.pdf\n件名：物件資料のご送付について\n――――――――\n山田商事株式会社（やまだ不動産）\n営業課長　山田 様\n\nお世話になっております。\nMD NEXT株式会社の下村と申します。\n\nご依頼の物件資料をお送りいたします。ご確認のほど、よろしくお願いいたします。\n■□ …（署名）\n――――――――",
        foot: "▶ 送信するには「送信」。",
      },
      { side: "out", time: "10:05", body: "送信" },
      { side: "in", head: "📧 送信しました。", body: "添付：物件資料.pdf" },
    ],
    chatCap: "名刺 → 宛先の自動解決 → PDF添付",
  },
  {
    id: "task",
    tag: "Task",
    tint: "--t-task",
    title: "タスクを登録する",
    card: "「◯◯を明日までに」でNotionに担当・期日つきで登録。",
    sub: "やることを普通に書くだけ。秘書が「これはタスクだ」と判断し、担当者・期日つきでNotionに登録します。@メンションで担当者を指定できます。",
    says: [
      {
        label: "例・担当と期日つき",
        text: "@杉山 弥生町の物件の査定書、明日の15時までに作成お願い",
      },
    ],
    points: [
      {
        b: "雑談は登録しません。",
        rest: "「今日暑いね」などの相槌は無視。やるべきこと、と読めた発言だけ登録します。",
      },
      {
        b: "担当者は@メンションで指定。",
        rest: "あとから引用リプライで担当を変えることもできます。",
      },
      {
        b: "間違いは取り消せる。",
        rest: "登録の返信に「タスクじゃない」と送れば取り消し。",
      },
    ],
    mechanism: {
      title: "裏側の仕組み — Notionのタスク管理と連携",
      body: "あなたの発言をAIが読み取り、「タイトル・カテゴリ・緊急度・担当・期日」に構造化して、NotionのタスクDBに1件追加します。登録したタスクは管理画面（ダッシュボード）でも一覧・ステータス変更ができます。",
      link: { href: "/dashboard", label: "タスク管理ダッシュボードを開く →" },
    },
    chat: [
      {
        side: "out",
        time: "11:20",
        head: "@杉山",
        body: "弥生町の物件の査定書、明日の15時までに作成お願い",
      },
      {
        side: "in",
        head: "✅ タスクを登録しました",
        body: "📋 弥生町の物件の査定書を作成\n👤 担当：杉山\n🗓 期日：明日 15:00",
        foot: "Notionに追加しました。",
      },
    ],
    chatCap: "発言 → Notionタスクへ自動登録",
  },
  {
    id: "crm",
    tag: "CRM",
    tint: "--t-crm",
    title: "顧客を登録する（CRM）",
    card: "「#新規」に続けて情報を書くと顧客リストへ登録。",
    sub: "紹介客が出たら、#新規 に続けて分かる範囲で情報を書くだけ。連絡先が電話だけ・メールだけ・「まだ聞けてない」でもOK。秘書が読み取って顧客リストに登録します。",
    reversed: true,
    says: [
      {
        label: "合図は #新規",
        text: "#新規 田中様の紹介で山本太郎さん 090-1234-5678 売却希望 3ヶ月以内 担当は杉山",
      },
    ],
    points: [
      { b: "氏名・フリガナ・電話・メール・エリア", rest: "" },
      { b: "相談内容（購入／売却など）・希望時期・個人／法人", rest: "" },
      { b: "担当者・紹介元・補足メモ", rest: "" },
    ],
    mechanism: {
      title: "裏側の仕組み — Notionの顧客DB（CRM_顧客）と連携",
      body: "合図は行頭の「#新規」（全角の ＃新規 も可）。それ以降の文をAIが読み取り、氏名・連絡先・相談内容・希望時期・紹介元などの項目に振り分けて、NotionのCRM（顧客リスト）に1件登録します。文の途中の行からでも拾います。",
    },
    chat: [
      {
        side: "out",
        time: "14:07",
        head: "#新規",
        body: "田中様の紹介で山本太郎さん 090-1234-5678 売却希望 3ヶ月以内 担当は杉山",
      },
      {
        side: "in",
        head: "🗂 顧客を登録しました",
        body: "👤 山本 太郎（個人）\n📞 090-1234-5678\n🏷 売却したい ／ 3ヶ月以内\n🙋 担当：杉山\n🔗 紹介元：田中様",
        foot: "CRM_顧客に追加しました。",
      },
    ],
    chatCap: "#新規 → CRM（顧客リスト）へ登録",
  },
  {
    id: "clarify",
    tag: "Assist",
    tint: "--t-mail",
    title: "迷ったら、秘書が聞いてくれる",
    card: "曖昧な指示のときだけ①〜④で確認。はっきりした指示は自動。",
    sub: "「対応しといて」のように、メール・タスク・顧客のどれとも取れる曖昧な指示のときだけ、秘書が確認します。はっきりした指示は今まで通り自動で進みます。",
    points: [
      { b: "はっきりしていれば聞かずに実行。", rest: "（「田中さんにメール送って」など）" },
      { b: "どれとも取れるときだけ①〜④で確認。", rest: "番号か「メール／タスク／顧客／なし」で答えるだけ。" },
      { b: "関係ない返事をすれば確認は解除。", rest: "普通の処理に戻るので詰まりません。" },
    ],
    note: "「聞きすぎ／聞かなさすぎ」と感じたら教えてください。実際の使われ方に合わせて調整できます。",
    chat: [
      { side: "out", time: "16:32", body: "山田さんの件、対応しといて" },
      {
        side: "in",
        menu: true,
        head: "🤔 これはどう対応しますか？",
        body: "① メールを作成して送る\n② タスクとして登録\n③ 顧客(CRM)に登録\n④ 何もしない",
        foot: "→ 番号か「メール／タスク／顧客／なし」で。",
      },
      { side: "out", time: "16:32", body: "②" },
      { side: "in", head: "✅ タスクを登録しました", body: "📋 山田さんの件を対応" },
    ],
    chatCap: "曖昧なときだけ確認 → 選んだ処理へ",
  },
];

const SAFETY = [
  {
    h: "勝手に送らない",
    p: "メールは必ず下書きを確認してから。「送信」と明確に返したときだけ送られます。修正指示が混ざると送信しません。",
  },
  {
    h: "写真・PDFに過敏に反応しない",
    p: "送っただけでは黙って控えるだけ。メールの指示が来たときにだけ名刺・資料として使います。",
  },
  {
    h: "雑談はタスクにしない",
    p: "相槌や報告は登録しません。「やること」と読める発言だけを拾います。",
  },
  {
    h: "やり直しがきく",
    p: "「キャンセル」で下書きを破棄。タスクは引用リプライで取り消し・担当変更ができます。",
  },
];

function Bubble({ m }: { m: ChatMsg }) {
  const cls = ["b", m.menu ? "sysmenu" : "", m.file ? "fileb" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={`msg ${m.side}`}>
      {m.side === "in" && <div className="ava">秘</div>}
      <div className={cls}>
        {m.head && <span className="hd">{m.head}</span>}
        {m.head && (m.body || m.foot) ? "\n" : ""}
        {m.body}
        {m.foot ? "\n" : ""}
        {m.foot && <span className="em">{m.foot}</span>}
      </div>
      {m.time && <span className="tm">{m.time}</span>}
    </div>
  );
}

export default function OverviewPage() {
  return (
    <main id="hisho">
      <style>{CSS}</style>

      <nav className="topbar">
        <div className="tb-inner">
          <a href="#top" className="brand">
            <span className="brand-mark">秘</span>
            <span>MD NEXT 秘書</span>
          </a>
          <div className="tb-links">
            {FEATURES.map((f) => (
              <a key={f.id} href={`#${f.id}`}>
                {f.title.replace(/（.*?）/g, "").split("・")[0].slice(0, 6)}
              </a>
            ))}
            <a href="#start">始め方</a>
          </div>
        </div>
      </nav>

      <header className="hero" id="top">
        <div className="wrap col">
          <span className="eyebrow">MD NEXT 秘書 / 社内利用ガイド</span>
          <h1>
            LINEに話しかけるだけで、
            <br />
            メール・タスク・顧客管理が終わる。
          </h1>
          <p className="lead">
            いつものLINEで文章を送るだけ。アプリの切り替えも、入力フォームも要りません。
            このページは、できることが増えるたびに更新される「機能ガイド」です。
            見たい項目をクリックすると、その使い方へ飛べます。
          </p>
          <div className="oneline">
            <span className="dot" />
            使い方はひとつ ——「公式LINEに、いつも通り話しかける」
            <span className="mono">no app · no form</span>
          </div>
        </div>
      </header>

      <section className="nav-section">
        <div className="wrap">
          <div className="sec-head">
            <span className="sec-num">MENU</span>
            <h2>できること（クリックで各説明へ）</h2>
          </div>
          <div className="grid">
            {FEATURES.map((f) => (
              <a
                key={f.id}
                href={`#${f.id}`}
                className="card"
                style={{ ["--tint" as string]: `var(${f.tint})` }}
              >
                <span className="tag">{f.tag}</span>
                <h3>{f.title}</h3>
                <p>{f.card}</p>
                <span className="jump">開く →</span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {FEATURES.map((f, i) => (
        <section key={f.id} id={f.id} className="feat-section">
          <div className="wrap">
            <div className="sec-head">
              <span className="sec-num">{String(i + 1).padStart(2, "0")}</span>
              <h2>{f.title}</h2>
            </div>
            <p className="sec-sub">{f.sub}</p>

            <div className={`feature${f.reversed ? " rev" : ""}`}>
              <div
                className="explain"
                style={{ ["--tint" as string]: `var(${f.tint})` }}
              >
                {f.says && f.says.length > 0 && (
                  <>
                    <h4>こう話しかけます</h4>
                    <div className="say">
                      {f.says.map((s, k) => (
                        <div className="q" key={k}>
                          <span className="lbl">{s.label}</span>
                          {s.text}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {f.points && f.points.length > 0 && (
                  <>
                    <h4>ポイント</h4>
                    <ul className="plain">
                      {f.points.map((p, k) => (
                        <li key={k}>
                          <b>{p.b}</b>
                          {p.rest}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {f.mechanism && (
                  <div className="mech">
                    <span className="mech-lbl">仕組み</span>
                    <h4>{f.mechanism.title}</h4>
                    <p>{f.mechanism.body}</p>
                    {f.mechanism.link && (
                      <Link className="mech-link" href={f.mechanism.link.href}>
                        {f.mechanism.link.label}
                      </Link>
                    )}
                  </div>
                )}
                {f.note && (
                  <div className="note">
                    <span className="ic" aria-hidden="true">
                      ✓
                    </span>
                    <p>{f.note}</p>
                  </div>
                )}
              </div>

              <div className="chat" aria-label={`${f.title}のLINE会話例`}>
                <div className="chat-bar">
                  <span className="av">秘</span>
                  <span className="nm">MD NEXT秘書</span>
                  <span className="st">LINE</span>
                </div>
                <div className="stream">
                  {f.chat.map((m, k) => (
                    <Bubble m={m} key={k} />
                  ))}
                </div>
                <div className="cap">{f.chatCap}</div>
              </div>
            </div>
          </div>
        </section>
      ))}

      <section className="feat-section" id="safety">
        <div className="wrap">
          <div className="sec-head">
            <span className="sec-num">✓</span>
            <h2>安心して使える設計</h2>
          </div>
          <div className="safety">
            {SAFETY.map((s, k) => (
              <div className="item" key={k}>
                <h4>
                  <span className="glyph" aria-hidden="true">
                    ✓
                  </span>
                  {s.h}
                </h4>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="feat-section" id="start">
        <div className="wrap">
          <div className="sec-head">
            <span className="sec-num">START</span>
            <h2>始め方</h2>
          </div>
          <div className="steps">
            <div className="step">
              <span className="n" />
              <h4>公式LINEを友だち追加</h4>
              <p>
                「MD NEXT秘書」を友だち追加、またはグループLINEに招待済みならそのまま使えます。
              </p>
            </div>
            <div className="step">
              <span className="n" />
              <h4>いつも通り話しかける</h4>
              <p>
                「◯◯さんにメール送って」「◯◯を明日までに」「#新規 …」など、ふだんの言葉でOK。
              </p>
            </div>
            <div className="step">
              <span className="n" />
              <h4>内容を確認して確定</h4>
              <p>メールは下書きを見て「送信」。タスク・顧客は登録内容を確認するだけ。</p>
            </div>
          </div>
          <div className="note" style={{ marginTop: 26 }}>
            <span className="ic" aria-hidden="true">
              !
            </span>
            <p>
              現在は<b>テスト運用（デモ）中</b>
              です。気づいた点・「もっとこう使いたい」という要望があれば、そのままLINEやチャットで教えてください。
              <b>新しくできることが増えたら、このページに追記して</b>いきます。
            </p>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap foot-inner">
          <span>MD NEXT 秘書 — 社内利用ガイド</span>
          <span className="badge">LINE × AI · powered by MD NEXT</span>
        </div>
      </footer>
    </main>
  );
}

const CSS = `
#hisho{
  --bg:#f4f6f3; --surface:#fff; --surface-2:#eef1ec; --ink:#17201a; --muted:#5b665d;
  --faint:#8a948b; --line:#dde3dc; --accent:#157a54; --accent-ink:#0d5b3d; --accent-soft:#e2efe8;
  --chat-bg:#d7e3da; --send:#06c755; --recv:#fff;
  --shadow:0 1px 2px rgba(20,40,28,.06),0 8px 24px rgba(20,40,28,.06);
  --shadow-lg:0 4px 12px rgba(20,40,28,.08),0 24px 60px rgba(20,40,28,.12);
  --t-mail:#157a54; --t-card:#0f7a86; --t-task:#b06a12; --t-crm:#6a4bb0;
  --radius:16px;
  --jp:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","YuGothic","Noto Sans JP","Meiryo",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono","SFMono-Regular","Menlo","Consolas",monospace;
  background:var(--bg); color:var(--ink); font-family:var(--jp); line-height:1.75;
  min-height:100dvh; letter-spacing:.01em; -webkit-font-smoothing:antialiased; scroll-behavior:smooth;
}
@media (prefers-color-scheme:dark){
  #hisho{
    --bg:#10140f; --surface:#181d17; --surface-2:#1f261e; --ink:#e9efe8; --muted:#a3b0a4;
    --faint:#77857a; --line:#2b332a; --accent:#4fce97; --accent-ink:#7fe0b3; --accent-soft:#16281f;
    --chat-bg:#10231a; --recv:#232a22;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
    --shadow-lg:0 4px 12px rgba(0,0,0,.5),0 24px 60px rgba(0,0,0,.55);
    --t-mail:#4fce97; --t-card:#43c3d1; --t-task:#e0a54e; --t-crm:#a98fe6;
  }
}
#hisho *{box-sizing:border-box;}
#hisho .wrap{max-width:1120px;margin:0 auto;padding:0 24px;}
#hisho .col{max-width:66ch;}
#hisho a{color:inherit;text-decoration:none;}

#hisho .topbar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line);}
#hisho .tb-inner{max-width:1120px;margin:0 auto;padding:11px 24px;display:flex;align-items:center;gap:20px;}
#hisho .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:15px;letter-spacing:-.01em;flex:none;}
#hisho .brand-mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(145deg,#1f5b3f,#0d3524);
  color:#eafff3;display:grid;place-items:center;font-size:13px;font-weight:800;}
#hisho .tb-links{display:flex;gap:6px;margin-left:auto;overflow-x:auto;-webkit-overflow-scrolling:touch;}
#hisho .tb-links a{font-size:13px;color:var(--muted);font-weight:600;padding:6px 11px;border-radius:8px;white-space:nowrap;transition:background .15s,color .15s;}
#hisho .tb-links a:hover{background:var(--accent-soft);color:var(--accent-ink);}

#hisho .hero{padding:64px 0 24px;}
#hisho .eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);
  font-weight:600;display:inline-flex;align-items:center;gap:9px;}
#hisho .eyebrow::before{content:"";width:22px;height:1.5px;background:var(--accent);display:inline-block;}
#hisho h1{font-size:clamp(30px,5.2vw,50px);line-height:1.18;margin:18px 0 0;font-weight:800;letter-spacing:-.01em;text-wrap:balance;}
#hisho .lead{font-size:clamp(16px,2vw,19px);color:var(--muted);margin:20px 0 0;max-width:62ch;}
#hisho .oneline{margin-top:30px;display:inline-flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--surface);
  border:1px solid var(--line);border-radius:999px;padding:11px 20px 11px 15px;box-shadow:var(--shadow);font-weight:600;font-size:15px;}
#hisho .oneline .dot{width:9px;height:9px;border-radius:50%;background:var(--send);box-shadow:0 0 0 4px color-mix(in srgb,var(--send) 22%,transparent);}
#hisho .oneline .mono{font-family:var(--mono);font-size:13px;color:var(--muted);font-weight:500;}

#hisho section{padding:46px 0;border-top:1px solid var(--line);scroll-margin-top:64px;}
#hisho .nav-section{border-top:0;}
#hisho .sec-head{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:8px;}
#hisho .sec-num{font-family:var(--mono);font-size:13px;color:var(--faint);font-weight:600;letter-spacing:.06em;}
#hisho h2{font-size:clamp(23px,3.4vw,31px);margin:0;font-weight:800;letter-spacing:-.01em;text-wrap:balance;}
#hisho .sec-sub{color:var(--muted);margin:10px 0 0;max-width:62ch;}

#hisho .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:26px;}
#hisho .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:22px;
  box-shadow:var(--shadow);position:relative;overflow:hidden;display:flex;flex-direction:column;transition:transform .2s,box-shadow .2s;}
#hisho .card::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--tint,var(--accent));}
#hisho .card:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);}
#hisho .card .tag{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--tint,var(--accent));font-weight:700;}
#hisho .card h3{margin:12px 0 6px;font-size:17px;font-weight:700;line-height:1.4;}
#hisho .card p{margin:0;color:var(--muted);font-size:14px;line-height:1.62;}
#hisho .card .jump{margin-top:14px;font-size:13px;font-weight:700;color:var(--tint,var(--accent));}

#hisho .feature{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start;margin-top:24px;}
#hisho .feature.rev .explain{order:2;}
@media (max-width:820px){#hisho .feature{grid-template-columns:1fr;gap:26px;}#hisho .feature.rev .explain{order:0;}}
#hisho .explain h4{font-size:16px;margin:22px 0 10px;font-weight:700;}
#hisho .explain h4:first-child{margin-top:0;}

#hisho ul.plain{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px;}
#hisho ul.plain li{position:relative;padding-left:26px;color:var(--muted);font-size:15px;}
#hisho ul.plain li::before{content:"";position:absolute;left:3px;top:9px;width:8px;height:8px;border-radius:2px;background:var(--tint,var(--accent));}
#hisho ul.plain li b{color:var(--ink);font-weight:700;}

#hisho .say{display:flex;flex-direction:column;gap:8px;}
#hisho .say .q{background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--tint,var(--accent)) 30%,var(--line));
  border-radius:12px;padding:9px 14px;font-size:14.5px;color:var(--ink);font-weight:600;}
#hisho .say .q .lbl{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--tint,var(--accent));
  display:block;margin-bottom:3px;font-weight:700;}

#hisho .mech{margin-top:22px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;box-shadow:var(--shadow);position:relative;}
#hisho .mech-lbl{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--tint,var(--accent));font-weight:700;}
#hisho .mech h4{margin:8px 0 8px;font-size:15.5px;}
#hisho .mech p{margin:0;color:var(--muted);font-size:14.5px;line-height:1.7;}
#hisho .mech-link{display:inline-block;margin-top:12px;font-size:13.5px;font-weight:700;color:var(--tint,var(--accent));
  border-bottom:1.5px solid color-mix(in srgb,var(--tint,var(--accent)) 40%,transparent);padding-bottom:1px;}

#hisho .note{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:start;background:var(--surface);
  border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow);margin-top:18px;}
#hisho .note .ic{color:var(--accent);margin-top:1px;font-weight:800;}
#hisho .note p{margin:0;font-size:14.5px;color:var(--muted);}
#hisho .note b{color:var(--ink);}

#hisho .chat{background:var(--chat-bg);border-radius:20px;overflow:hidden;box-shadow:var(--shadow-lg);border:1px solid var(--line);position:sticky;top:76px;}
@media (max-width:820px){#hisho .chat{position:static;}}
#hisho .chat-bar{background:var(--surface);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:11px;padding:12px 16px;}
#hisho .chat-bar .av{width:30px;height:30px;border-radius:50%;background:linear-gradient(145deg,#1f5b3f,#0d3524);display:grid;place-items:center;color:#eafff3;font-weight:800;font-size:12px;flex:none;}
#hisho .chat-bar .nm{font-weight:700;font-size:14px;}
#hisho .chat-bar .st{font-size:11px;color:var(--faint);margin-left:auto;font-family:var(--mono);letter-spacing:.04em;}
#hisho .stream{padding:18px 16px 20px;display:flex;flex-direction:column;gap:14px;}
#hisho .msg{display:flex;gap:9px;max-width:92%;}
#hisho .msg.in{align-self:flex-start;}
#hisho .msg.out{align-self:flex-end;flex-direction:row-reverse;}
#hisho .msg .ava{width:26px;height:26px;border-radius:50%;flex:none;background:linear-gradient(145deg,#1f5b3f,#0d3524);display:grid;place-items:center;color:#eafff3;font-size:10px;font-weight:800;}
#hisho .b{border-radius:15px;padding:9px 13px;font-size:13.5px;line-height:1.6;white-space:pre-line;word-break:normal;overflow-wrap:anywhere;}
#hisho .msg.in .b{background:var(--recv);color:var(--ink);border-top-left-radius:4px;box-shadow:0 1px 1px rgba(0,0,0,.05);}
#hisho .msg.out .b{background:var(--send);color:#032b16;border-top-right-radius:4px;font-weight:500;}
#hisho .b.fileb{opacity:.92;font-style:normal;}
#hisho .msg.out .b.fileb{background:color-mix(in srgb,var(--send) 55%,var(--surface));color:var(--ink);}
#hisho .b.sysmenu{background:var(--surface);border:1px dashed color-mix(in srgb,var(--accent) 45%,var(--line));color:var(--ink);}
#hisho .msg .tm{align-self:flex-end;font-size:10px;color:var(--faint);font-family:var(--mono);flex:none;margin-bottom:2px;}
#hisho .b .hd{font-weight:700;}
#hisho .b .em{color:var(--faint);}
#hisho .cap{text-align:center;font-size:11.5px;color:var(--faint);font-family:var(--mono);letter-spacing:.04em;margin:12px 16px 16px;}

#hisho .safety{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-top:26px;}
#hisho .safety .item{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;box-shadow:var(--shadow);}
#hisho .safety .item h4{margin:0 0 7px;font-size:15.5px;display:flex;align-items:center;gap:9px;}
#hisho .safety .item h4 .glyph{color:var(--accent);font-weight:800;}
#hisho .safety .item p{margin:0;color:var(--muted);font-size:14px;line-height:1.62;}

#hisho .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:26px;counter-reset:s;}
#hisho .step{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:var(--shadow);}
#hisho .step .n{counter-increment:s;font-family:var(--mono);font-weight:700;color:var(--accent);font-size:13px;letter-spacing:.1em;}
#hisho .step .n::before{content:"STEP " counter(s);}
#hisho .step h4{margin:8px 0 6px;font-size:16px;}
#hisho .step p{margin:0;color:var(--muted);font-size:14px;}

#hisho footer{border-top:1px solid var(--line);padding:34px 0 60px;color:var(--faint);font-size:13px;}
#hisho .foot-inner{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center;}
#hisho .badge{font-family:var(--mono);font-size:11px;letter-spacing:.08em;}
@media (prefers-reduced-motion:reduce){#hisho{scroll-behavior:auto;}#hisho .card:hover{transform:none;}}
`;
