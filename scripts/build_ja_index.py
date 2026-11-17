"""Build site/ja/index.html (the Japanese landing page) from site/index.html.

Run from the repo root after changing the English landing page:
    uv run --no-project python -I scripts/build_ja_index.py

Every (english, japanese, count) entry must match the English page exactly
`count` times, or the script stops and names it, so an English copy edit
can't silently leave stale text on the Japanese page.

The Japanese page lives one folder down, so relative asset paths (icons,
screenshots, xml, tools, custom-tools) are rewritten to point back up. The
tool URLs shown under Manual install therefore stay the same as on the
English page; the tools themselves are English-only.

P4V menu paths (Tools > Manage Tools, HTML Tabs, ...) are left in English
on purpose: they need checking against P4V's Japanese UI first.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "site" / "index.html"
DST = ROOT / "site" / "ja" / "index.html"

PAIRS = [
    # ---------- head ----------
    ('<html lang="en">', '<html lang="ja">', 1),
    (
        "<title>Ultimate P4V Toolkit | Jase Lindgren</title>",
        "<title>Ultimate P4V Toolkit（P4V・P4Admin用ツール集） | Jase Lindgren</title>",
        1,
    ),
    (
        'content="Free tools for P4V and P4Admin: live maps of who has what checked out, server activity trends, depot sizes and more. Import the tool files and they appear in P4V."',
        'content="P4VとP4Admin用の無料ツール集。誰が何をチェックアウトしているかのライブマップ、サーバのアクティビティ推移、ディポのサイズなど。ツールファイルをインポートするだけでP4Vに表示されます。"',
        1,
    ),
    (
        "family=Space+Mono:wght@400;700&display=swap",
        "family=M+PLUS+1+Code:wght@400;700&family=Space+Mono:wght@400;700&display=swap",
        1,
    ),
    (
        """        color: var(--ink);
        font-family: "Space Mono", monospace;""",
        """        color: var(--ink);
        font-family: "Space Mono", "M PLUS 1 Code", monospace;
        line-break: strict;
        word-break: auto-phrase;""",
        1,
    ),
    ('font-family: "Space Mono", monospace;', 'font-family: "Space Mono", "M PLUS 1 Code", monospace;', 1),
    # ---------- hero / intro ----------
    (
        "Free&nbsp;&nbsp;·&nbsp;&nbsp;Nothing to install&nbsp;&nbsp;·&nbsp;&nbsp;Works in P4V and P4Admin",
        "無料&nbsp;&nbsp;·&nbsp;&nbsp;インストール不要&nbsp;&nbsp;·&nbsp;&nbsp;P4VとP4Adminで動作",
        1,
    ),
    (
        """          New tabs and right-click tools for P4V and P4Admin. See who has what
          checked out, what's been changing across the server, and where all
          the space is going.""",
        """          P4VとP4Adminに新しいタブと右クリックツールを追加します。誰が何をチェックアウトしているか、サーバ全体で何が変更されているか、容量がどこで使われているかがわかります。""",
        1,
    ),
    (
        """          They run inside P4V using the login you already have, so there's no
          app to install and nothing to set up on the server. Import the tool
          files into P4V and they're ready to use, and they update by
          themselves whenever the toolkit does.""",
        """          ツールはP4Vの中で、今お使いのログインのまま動作します。アプリのインストールもサーバ側の設定も必要ありません。ツールファイルをP4Vにインポートすればすぐに使え、ツールキットが更新されると自動的に最新版になります。""",
        1,
    ),
    # ---------- install ----------
    ("install in a minute <span", "1分でインストール <span", 1),
    ('<div class="step-num">Step 1</div>', '<div class="step-num">ステップ 1</div>', 1),
    ('<div class="step-num">Step 2</div>', '<div class="step-num">ステップ 2</div>', 1),
    ("<h3>Download the tools</h3>", "<h3>ツールをダウンロード</h3>", 1),
    ('<div class="dl-group">For P4V</div>', '<div class="dl-group">P4V用</div>', 1),
    (
        '<div class="dl-group">For P4Admin (admins)</div>',
        '<div class="dl-group">P4Admin用（管理者向け）</div>',
        1,
    ),
    (
        '<span class="dl-what">The five tabs. Start here.</span>',
        '<span class="dl-what">5つのタブ。まずはこちらから。</span>',
        1,
    ),
    (
        '<span class="dl-what">Revert Exclusive Checkouts (admins) and Virtual Stream Utility.</span>',
        '<span class="dl-what">Revert Exclusive Checkouts（管理者向け）とVirtual Stream Utility。</span>',
        1,
    ),
    (
        '<span class="dl-what">Export .p4config, on a Windows PC</span>',
        '<span class="dl-what">Export .p4config（Windows PC用）</span>',
        1,
    ),
    (
        '<span class="dl-what">Export .p4config, on a Mac</span>',
        '<span class="dl-what">Export .p4config（Mac用）</span>',
        1,
    ),
    (
        '<span class="dl-what">Typemap Editor and AI Help, as P4Admin tabs</span>',
        '<span class="dl-what">Typemap EditorとAI Help（P4Adminのタブとして）</span>',
        1,
    ),
    (
        '<span class="dl-what">Reset User Password, on a Windows PC</span>',
        '<span class="dl-what">Reset User Password（Windows PC用）</span>',
        1,
    ),
    (
        '<span class="dl-what">Reset User Password, on a Mac</span>',
        '<span class="dl-what">Reset User Password（Mac用）</span>',
        1,
    ),
    ("<h3>Import them</h3>", "<h3>インポートする</h3>", 1),
    (
        """                Each file goes in its own place, under
                <span class="menu-path">Tools &gt; Manage Tools</span>. Pick
                the item below, click <em>Import</em>, and choose the file.""",
        """                各ファイルは
                <span class="menu-path">Tools &gt; Manage Tools</span>
                の中の、それぞれ決まった場所にインポートします。下記の項目を選んで<em>Import</em>をクリックし、ファイルを選択してください。""",
        1,
    ),
    (
        """                  <strong>p4v-tabs.xml</strong>: in P4V,
                  <span class="menu-path">HTML Tabs</span>. Open the tabs from
                  the <span class="menu-path">View</span> menu.""",
        """                  <strong>p4v-tabs.xml</strong>：P4Vの
                  <span class="menu-path">HTML Tabs</span>に。タブは
                  <span class="menu-path">View</span>メニューから開きます。""",
        1,
    ),
    (
        """                  <strong>p4v-right-click-tools.xml</strong>: in P4V,
                  <span class="menu-path">HTML Windows</span> (P4V's name for
                  tools that open in their own window). Right-click files or
                  folders for Revert Exclusive Checkouts, or a virtual stream
                  for Virtual Stream Utility.""",
        """                  <strong>p4v-right-click-tools.xml</strong>：P4Vの
                  <span class="menu-path">HTML Windows</span>（別ウィンドウで開くツールのP4Vでの呼び名）に。ファイルやフォルダを右クリックするとRevert
                  Exclusive Checkouts、バーチャルストリームを右クリックするとVirtual Stream Utilityが使えます。""",
        1,
    ),
    (
        """                  <strong>p4v-custom-tools-pc.xml</strong> or
                  <strong>p4v-custom-tools-mac.xml</strong>: in P4V,
                  <span class="menu-path">Custom Tools</span>. Run it from the
                  <span class="menu-path">Tools</span> menu.""",
        """                  <strong>p4v-custom-tools-pc.xml</strong>または
                  <strong>p4v-custom-tools-mac.xml</strong>：P4Vの
                  <span class="menu-path">Custom Tools</span>に。
                  <span class="menu-path">Tools</span>メニューから実行します。""",
        1,
    ),
    (
        """                  <strong>p4admin-tabs.xml</strong>: in P4Admin,
                  <span class="menu-path">HTML Tabs</span>. Open the tabs from
                  the <span class="menu-path">View</span> menu.""",
        """                  <strong>p4admin-tabs.xml</strong>：P4Adminの
                  <span class="menu-path">HTML Tabs</span>に。タブは
                  <span class="menu-path">View</span>メニューから開きます。""",
        1,
    ),
    (
        """                  <strong>p4admin-custom-tools-pc.xml</strong> or
                  <strong>p4admin-custom-tools-mac.xml</strong>: in P4Admin,
                  <span class="menu-path">Custom Tools</span>. Right-click a
                  user to use it.""",
        """                  <strong>p4admin-custom-tools-pc.xml</strong>または
                  <strong>p4admin-custom-tools-mac.xml</strong>：P4Adminの
                  <span class="menu-path">Custom Tools</span>に。ユーザを右クリックして使います。""",
        1,
    ),
    (
        """                Before importing, P4V lists every tool in the file. Untick any
                you don't want. Tools marked <em>(Admin)</em> only work for
                admins and super users, so everyone else can leave them out.""",
        """                インポートの前に、P4Vがファイル内のツールを一覧表示します。不要なものはチェックを外してください。<em>(Admin)</em>と付いたツールは管理者とスーパーユーザしか使えないので、それ以外の方は外して構いません。""",
        1,
    ),
    (
        """                If a tool won't load, check the permitted base URLs in
                <span class="menu-path">Preferences &gt; HTML Tools</span>. If
                that list is limited, <code>https://jase.town</code> needs to be
                on it.""",
        """                ツールが読み込まれない場合は、
                <span class="menu-path">Preferences &gt; HTML Tools</span>
                の許可されたベースURLを確認してください。リストが制限されている場合は、<code>https://jase.town</code>を追加する必要があります。""",
        1,
    ),
    (
        """          <strong>Running a team?</strong> A server admin can give everyone in
          P4V the tabs and right-click tools at once, with no importing, by
          pointing P4V at the same files. See <a href="#manual">Manual install</a> below for the
          commands.""",
        """          <strong>チームで使う場合：</strong>サーバ管理者がP4Vの参照先をこれらのファイルに設定すれば、インポートなしで全員にタブと右クリックツールを一度に配布できます。コマンドは下の<a href="#manual">手動インストール</a>をご覧ください。""",
        1,
    ),
    # ---------- privacy ----------
    ("your data stays put <span", "データは外に出ません <span", 1),
    (
        """          The tools get their data from your P4 Server through P4V, using
          your login, and do all the sorting, adding up and drawing on your
          own computer. Nothing from your server is ever sent anywhere else.
          Server Activity's saved history stays on your computer too.""",
        """          ツールはあなたのログインを使い、P4Vを通じてP4 Serverからデータを取得します。並べ替えや集計、描画はすべてお使いのコンピュータ上で行われ、サーバのデータが外部に送られることは一切ありません。Server Activityの履歴も、お使いのコンピュータ内にだけ残ります。""",
        1,
    ),
    (
        """          The one exception is <strong>AI Help</strong>, which sends the
          question you type to Perforce's official AI support assistant to
          get an answer.""",
        """          唯一の例外は<strong>AI Help</strong>です。入力した質問を、回答を得るためにPerforce公式のAIサポートアシスタントへ送信します。""",
        1,
    ),
    # ---------- tools / manual headings ----------
    ("the tools <span", "ツール一覧 <span", 1),
    ("manual install <span", "手動インストール <span", 1),
    (
        '<span class="glitch">Set up tools one at a time, or for your whole team</span>',
        '<span class="glitch">ツールを個別に、またはチーム全体に設定する</span>',
        1,
    ),
    (
        """              Each tool is a web page that P4V loads. To add one by hand, go to
              <span class="menu-path">Tools &gt; Manage Tools</span>, add a new
              HTML Tab or HTML Window, and fill in the values below.""",
        """              各ツールは、P4Vが読み込むWebページです。手動で追加するには
              <span class="menu-path">Tools &gt; Manage Tools</span>
              で新しいHTML TabまたはHTML Windowを追加し、以下の値を入力してください。""",
        1,
    ),
    (
        '<h3>Roll out to your whole P4V team <span class="tag">Server admins</span></h3>',
        '<h3>P4Vチーム全体に配布する <span class="tag">サーバ管理者</span></h3>',
        1,
    ),
    (
        """                P4V picks these up the next time people connect. They only cover
                the tabs and right-click tools, so Export .p4config is still
                imported in P4V, and Reset User Password in P4Admin.
                If your server uses <code>P4VJS.HTMLAllowList</code>, add
                <code>https://jase.town</code> to it.""",
        """                各ユーザが次回接続したときにP4Vに反映されます。対象はタブと右クリックツールのみなので、Export
                .p4configはP4Vで、Reset User PasswordはP4Adminで、引き続き個別にインポートしてください。
                サーバで<code>P4VJS.HTMLAllowList</code>を使っている場合は、<code>https://jase.town</code>を追加してください。""",
        1,
    ),
    (
        "<span>Want to change a tool or host your own copy? Everything is open source (MIT).</span>",
        "<span>ツールの改造や自前でのホストも自由です。すべてオープンソース（MIT）で公開しています。</span>",
        1,
    ),
    (
        '<span class="glitch">source on github →</span>',
        '<span class="glitch">GitHubでソースを見る →</span>',
        1,
    ),
    (
        "<div>© 2026 Jase Lindgren for Perforce Software</div>",
        "<div>© 2026 Jase Lindgren for Perforce Software</div>",
        1,
    ),
    # ---------- tool data (rendered by the script) ----------
    ('who: "Everyone",', 'who: "全員",', 6),
    ('who: "Admins",', 'who: "管理者",', 2),
    ('who: "Super users",', 'who: "スーパーユーザ",', 1),
    ('tool.who === "Everyone"', 'tool.who === "全員"', 1),
    ('"screenshots/project-activity.webp", "Map"]', '"screenshots/project-activity.webp", "マップ"]', 1),
    ('"screenshots/depot-size-map.webp", "Map"]', '"screenshots/depot-size-map.webp", "マップ"]', 1),
    ('"screenshots/server-activity.webp", "Trends"]', '"screenshots/server-activity.webp", "推移"]', 1),
    ('"screenshots/server-activity-calendar.webp", "Calendar"]', '"screenshots/server-activity-calendar.webp", "カレンダー"]', 1),
    ('"screenshots/server-activity-people.webp", "People"]', '"screenshots/server-activity-people.webp", "ユーザ"]', 1),
    ('.webp", "Window"]', '.webp", "ウィンドウ"]', 2),
    ('"screenshots/typemap.webp", "Editor"]', '"screenshots/typemap.webp", "エディタ"]', 1),
    ('"screenshots/ai-help.webp", "Search"]', '"screenshots/ai-help.webp", "検索"]', 1),
    (
        '"A live map of every checked-out file in your project, coloured by who has it. Exclusive checkouts show a lock, and files that several people have open stand out, so you can see clashes before they happen."',
        '"プロジェクト内でチェックアウトされているすべてのファイルを、誰が持っているかで色分けしたライブマップ。排他チェックアウトには鍵が表示され、複数人が開いているファイルは目立つので、競合を事前に把握できます。"',
        1,
    ),
    (
        '"Who\'s working where, and what\'s been changing. Trends over time by person, folder or action, a calendar of activity for each stream, and a map of which folders have gone quiet. History is saved on your computer, so it\'s quick the next time."',
        '"誰がどこで作業していて、何が変更されているか。ユーザ・フォルダ・操作別の推移、ストリームごとのアクティビティカレンダー、更新が止まったフォルダのマップを表示します。履歴はお使いのコンピュータに保存されるので、次回からはすばやく開けます。"',
        1,
    ),
    (
        '"Find out where the space goes. Zoom through folders sized by how big they are, compare what a sync downloads with everything stored on the server, include shelved files, and find the biggest files. Opens quickly even on huge depots."',
        '"容量がどこで使われているかを調べられます。サイズに応じた大きさで表示されるフォルダをズームしながらたどり、同期でダウンロードされる量とサーバに保存されている全体を比較できます。保留されたファイルも含められ、最大のファイルも見つかります。巨大なディポでもすばやく開きます。"',
        1,
    ),
    (
        '"Someone left a file exclusively checked out and isn\'t around to release it? Right-click the folder, see every exclusive checkout inside it with who has it and since when, and release the ones you pick."',
        '"誰かがファイルを排他チェックアウトしたまま不在で、解除できない？フォルダを右クリックすると、その中の排他チェックアウトを、誰がいつからチェックアウトしているかと合わせて一覧表示し、選んだものを解除できます。"',
        1,
    ),
    (
        '"Choose what a virtual stream shows by ticking folders and files in its parent, instead of writing its Paths by hand. It writes the shortest list of share and exclude lines, shows you the result before you save, and leaves wildcard lines it can\'t show untouched."',
        '"バーチャルストリームに何を含めるかを、Pathsを手で書く代わりに、親ストリームのフォルダやファイルにチェックを入れて選べます。shareとexcludeの行を最短のリストで書き出し、保存前に結果を確認でき、表示できないワイルドカード行はそのまま残します。"',
        1,
    ),
    (
        '"Edit the server\'s typemap in a table instead of a text file. It warns you when one rule overrides another, and has ready-made templates for game projects."',
        '"サーバのタイプマップを、テキストファイルではなく表で編集できます。ルール同士が上書きし合う場合は警告し、ゲームプロジェクト向けのテンプレートも用意されています。"',
        1,
    ),
    (
        '"Ask a question about P4 in plain words and get an answer with links to the official documentation and knowledge base articles it came from."',
        '"P4についてふだんの言葉で質問すると、根拠となった公式ドキュメントやナレッジベース記事へのリンク付きで回答が得られます。"',
        1,
    ),
    (
        '"Give someone a temporary password and make them choose a new one when they next log in. The message to send them is copied for you. Needs the p4 command-line client."',
        '"ユーザに一時パスワードを発行し、次回ログイン時に新しいパスワードを設定させます。本人に送るメッセージは自動でコピーされます。p4コマンドラインクライアントが必要です。"',
        1,
    ),
    (
        '"Save your current workspace\'s server, user and workspace name in a .p4config file at its root, so the p4 command line, game engines and other tools connect the same way P4V does inside that folder. It never overwrites an existing file."',
        '"現在のワークスペースのサーバ、ユーザ、ワークスペース名を、そのルートの.p4configファイルに保存します。これでそのフォルダ内では、p4コマンドラインやゲームエンジンなどのツールがP4Vと同じ設定で接続できます。既存のファイルは上書きしません。"',
        1,
    ),
    ('find: "View > Active Files",', 'find: "View > Active Files",', 1),
    (
        'find: "In P4V, right-click files or folders > Revert Exclusive Checkouts (Admin)",',
        'find: "P4Vでファイルやフォルダを右クリック > Revert Exclusive Checkouts (Admin)",',
        1,
    ),
    (
        'find: "In P4V, right-click a virtual stream > Virtual Stream Utility",',
        'find: "P4Vでバーチャルストリームを右クリック > Virtual Stream Utility",',
        1,
    ),
    (
        'find: "View > Typemap Editor (Admin), in P4V or P4Admin",',
        'find: "View > Typemap Editor (Admin)（P4VまたはP4Admin）",',
        1,
    ),
    ('find: "View > AI Help, in P4V or P4Admin",', 'find: "View > AI Help（P4VまたはP4Admin）",', 1),
    (
        'find: "In P4Admin, right-click a user > Reset User Password (Super User)",',
        'find: "P4Adminでユーザを右クリック > Reset User Password (Super User)",',
        1,
    ),
    ('find: "In P4V, Tools > Export .p4config",', 'find: "P4Vで Tools > Export .p4config",', 1),
    (
        'before: "Want it in P4Admin too? Import ",',
        'before: "P4Adminでも使いたい場合は、",',
        1,
    ),
    (
        'after: " in P4Admin under Manage Tools > HTML Windows.",',
        'after: " をP4AdminのManage Tools > HTML Windowsにインポートしてください。",',
        1,
    ),
    ('before: "For P4Admin, import ",', 'before: "P4Adminでは、",', 2),
    (
        'after: " under Manage Tools > HTML Tabs.",',
        'after: " をManage Tools > HTML Tabsにインポートしてください。",',
        2,
    ),
    ('before: "Import ",', 'before: "",', 2),
    ('"the Windows PC file"]', '"Windows PC用ファイル"]', 2),
    ('"the Mac file"]', '"Mac用ファイル"]', 2),
    (
        'after: " in P4Admin under Manage Tools > Custom Tools.",',
        'after: " をP4AdminのManage Tools > Custom Toolsにインポートしてください。",',
        1,
    ),
    (
        'after: " in P4V under Manage Tools > Custom Tools.",',
        'after: " をP4VのManage Tools > Custom Toolsにインポートしてください。",',
        1,
    ),
    (
        'placeholder: ["RESET USER PASSWORD", "Right-click a user in P4Admin"],',
        'placeholder: ["RESET USER PASSWORD", "P4Adminでユーザを右クリック"],',
        1,
    ),
    (
        'placeholder: ["EXPORT .P4CONFIG", "Tools menu in P4V"],',
        'placeholder: ["EXPORT .P4CONFIG", "P4VのToolsメニュー"],',
        1,
    ),
    # ---------- script UI strings ----------
    ('className: "copy" }, "Copy");', 'className: "copy" }, "コピー");', 1),
    ('ok ? "Copied" : "Failed";', 'ok ? "コピーしました" : "失敗しました";', 1),
    ('(btn.textContent = "Copy")', '(btn.textContent = "コピー")', 1),
    ('"aria-label": `Show ${label}`', '"aria-label": `${label}を表示`', 1),
    (
        'tool.kind === "Tab" ? "P4V tab" : tool.customTool ? `${tool.app} ${tool.kind === "Tools menu" ? "Tools menu" : "right-click tool"}` : "P4V right-click tool"',
        'tool.kind === "Tab" ? "P4Vタブ" : tool.customTool ? `${tool.app}の${tool.kind === "Tools menu" ? "Toolsメニュー" : "右クリックツール"}` : "P4V右クリックツール"',
        1,
    ),
    ('el("strong", {}, "find it"),', 'el("strong", {}, "場所"),', 1),
    ('el("strong", {}, "install"),', 'el("strong", {}, "インストール"),', 1),
    ('i ? " or " : "",', 'i ? "または" : "",', 1),
    ('...field("Argument", m.arg)', '...field("引数", m.arg)', 1),
    ('...field("Window size", m.size)', '...field("ウィンドウサイズ", m.size)', 1),
    (
        '...field("Options", m.note || "Add to applicable context menus")',
        '...field("オプション", m.note || "Add to applicable context menus")',
        1,
    ),
    (
        '...field("Add it as", `Custom Tool, in ${tool.app} (Tools > Manage Tools > Custom Tools > New > Tool…)`)',
        '...field("追加方法", `${tool.app}のCustom Toolとして（Tools > Manage Tools > Custom Tools > New > Tool…）`)',
        1,
    ),
    ('...field("Options", def.options.join(", "))', '...field("オプション", def.options.join(", "))', 1),
    (
        """                    "Note",
                    "Paste the Arguments exactly as shown, without adding quotes. They contain the script encoded as base64.\"""",
        """                    "注意",
                    "Argumentsは引用符を付けず、表示どおりに貼り付けてください。base64でエンコードしたスクリプトが含まれています。\"""",
        1,
    ),
    ('el("dt", {}, "Source"),', 'el("dt", {}, "ソース"),', 2),
    (
        '...field("Error", `Couldn\'t load this tool\'s settings: ${err.message}`)',
        '...field("エラー", `このツールの設定を読み込めませんでした: ${err.message}`)',
        1,
    ),
    ('...field("Tabs", `p4 property', '...field("タブ", `p4 property', 1),
    ('...field("Right-click tools", `p4 property', '...field("右クリックツール", `p4 property', 1),
]

# Relative asset paths, as they appear after a quote or backtick.
ASSET_PATH = re.compile(r'(["`])(icons|screenshots|xml|tools|custom-tools)/')

LANG_LINKS = """    <link rel="alternate" hreflang="en" href="/ultimate-p4v-toolkit/" />
    <link rel="alternate" hreflang="ja" href="/ultimate-p4v-toolkit/ja/" />
    <script src="/lang.js"></script>
"""


def main() -> int:
    html = SRC.read_text(encoding="utf-8").replace("\r\n", "\n")
    if LANG_LINKS not in html:
        print("site/index.html is missing the hreflang links / lang.js include")
        return 1

    bad = []
    for en, ja, want in PAIRS:
        got = html.count(en)
        if got != want:
            bad.append(f"expected {want}, found {got}: {en[:80]!r}")
            continue
        html = html.replace(en, ja)
    if bad:
        print("English page no longer matches the translation table:")
        print("\n".join("  " + b for b in bad))
        return 1

    html, n = ASSET_PATH.subn(r"\1../\2/", html)
    print(f"rewrote {n} asset paths")

    DST.parent.mkdir(exist_ok=True)
    DST.write_text(html, encoding="utf-8", newline="\n")
    print(f"wrote {DST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
