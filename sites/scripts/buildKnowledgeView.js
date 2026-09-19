/*
@config : connectionSetting.json
@filename : buildKnowledgeView.js
@title : buildKnowledgeView
@name : buildKnowledgeView
@siteIds : 22
@siteTitles : ナレッジ
@disabled: false
*/

(function () {
// @siteid list start@
    var FOLDER_SITE_ID = 22;     // このスクリプトが動作する「ナレッジ」フォルダ自体のサイトID
    var TAG_SITE_ID = 23;        // タグテーブルのサイトID
    var KNOWLEDGE_SITE_ID = 21;  // ナレッジテーブルのサイトID
    var SETTING_SITE_ID = 24;    // 設定テーブルのサイトID（現時点では未使用。今後の設定機能用に予約）
// @siteid list end@

    // ナレッジの項目構成:
    //   ClassA = タグ（検索補助のためのメタ情報。複数選択・JSON配列文字列で保存）
    //   ClassB = 親ページ（ナレッジ自身へのリンク。単一選択・階層構造を表す）

    // ナレッジフォルダのIndex画面でのみ実行する。
    // $p.id()は一覧画面ではサイトIDを返すため、フォルダ自体のサイトIDと比較している。
    if (typeof $p === "undefined" || $p.id() !== FOLDER_SITE_ID) {
        return;
    }

    var tagTitleById = {};      // タグID -> タグ名
    var knowledgeById = {};     // ResultId -> { ResultId, Title, ParentId, Order, UpdatedTime, Updator }（一覧・ツリー用の軽量情報のみ保持）
    var childrenByParent = {};  // 親ID（ルートは""）-> 子ResultIdの配列
    var expandedIds = {};       // ResultId -> ツリーで展開中かどうか
    var sidebarSearchKeyword = "";      // サイドバーのページ名検索キーワード
    var activeSidebarTagFilter = null;  // サイドバーで絞り込み中のタグID
    var tagFilterResultIds = null;      // タグ絞り込み中に該当するResultId配列（クリック時にapiGetで取得）
    var sidebarSearchDebounceTimer = null;
    var currentResultId = null;
    var currentTagIds = [];     // 編集中ページに現在付与されているタグID一覧
    var userNameById = {};      // ユーザID -> 表示名のキャッシュ（更新者表示用）
    var seenTimeByResultId = {}; // ResultId -> 最後に開いたときのUpdatedTime（未確認の更新判定用）
    var isDirty = false;        // 未保存の変更があるかどうか
    var built = false;          // ナレッジビューのUIを構築済みかどうか
    var bodyViewMode = "preview"; // 本文の表示モード（"edit" | "preview"）既定はプレビュー
    var markdownLibsPromise = null; // marked.js / DOMPurify の読み込みPromiseをキャッシュ
    var mermaidLibPromise = null; // mermaid.jsの読み込みPromiseをキャッシュ（mermaidブロックがあるときのみ遅延読み込み）
    var hljsLibPromise = null; // highlight.jsの読み込みPromiseをキャッシュ（コードブロックがあるときのみ遅延読み込み）
    var draggedResultId = null; // ツリーでD&D中のResultId（ドラッグ中のみ非null）
    var knownServerBody = ""; // 現在開いているページのサーバー側Bodyの最新スナップショット（画像貼り付けの差分抽出用）
    var ENABLED_STORAGE_KEY = "knowledgeView.enabled." + FOLDER_SITE_ID;
    var LAST_OPENED_STORAGE_KEY = "knowledgeView.lastOpened." + FOLDER_SITE_ID;
    var SEEN_TIMES_STORAGE_KEY = "knowledgeView.seenTimes." + FOLDER_SITE_ID;
    var MARKED_URL = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
    var DOMPURIFY_URL = "https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js";
    var MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js";
    var HLJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
    var HLJS_CSS_URL = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";
    var MARKDOWN_MARKER = "[md]"; // 本文がMarkdown記法であることを示す先頭マーカー

    try {
        seenTimeByResultId = JSON.parse(window.localStorage.getItem(SEEN_TIMES_STORAGE_KEY) || "{}");
    } catch (e) {
        seenTimeByResultId = {};
    }

    $(function () {
        injectStyles();
        applyViewParamOverride(); // ?view=on/off でlocalStorageを上書きする
        renderToggle();
        applyViewState(isViewEnabled());
        bindBodyModeShortcut();
        bindSaveShortcut();
        bindSearchOutsideClick();
        bindUnloadWarning();
    });

    function bindBodyModeShortcut() {
        // Ctrl+Shift+V で本文のエディタ/プレビュー/同時表示を順に切り替える
        var order = ["edit", "preview", "split"];
        $(document).on("keydown", function (e) {
            if (!currentResultId) return;
            if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
                e.preventDefault();
                setBodyMode(order[(order.indexOf(bodyViewMode) + 1) % order.length]);
            }
        });
    }

    function bindSaveShortcut() {
        // Ctrl+S（Macはcmd+S）で保存する。自動保存は行わない。
        $(document).on("keydown", function (e) {
            if (!currentResultId) return;
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "s" || e.key === "S")) {
                e.preventDefault();
                saveCurrentKnowledge();
            }
        });
    }

    function bindUnloadWarning() {
        // 保存されていない変更がある状態でブラウザタブを離れようとした場合に警告する
        window.addEventListener("beforeunload", function (e) {
            if (!isDirty) return;
            e.preventDefault();
            e.returnValue = "";
        });
    }

    function bindSearchOutsideClick() {
        // 検索ボックス以外をクリックしたら検索結果を閉じる（DOMは都度作り直されるため委譲で1回だけ登録）
        $(document).on("click", function () {
            if ($("#knowledgeSearchResults").hasClass("is-open")) closeKnowledgeSearch();
        });
    }

    // Qiita風の配色・タイポグラフィを1つの<style>にまとめて注入する
    function injectStyles() {
        if ($("#knowledgeViewStyle").length) return;
        $("<style>", {
            id: "knowledgeViewStyle",
            text:
                "#knowledgeViewToggleLabel{display:inline-flex;align-items:center;gap:8px;" +
                "font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN'," +
                "'Hiragino Sans',Meiryo,sans-serif;font-size:0.8em;color:#767676;cursor:pointer;}" +
                "#knowledgeHeaderControls{position:absolute;top:50%;right:16px;transform:translateY(-50%);" +
                "display:inline-flex;align-items:center;gap:16px;z-index:10;}" +
                ".toggle-switch{position:relative;display:inline-block;width:38px;height:21px;flex:0 0 auto;}" +
                ".toggle-switch input{position:absolute;opacity:0;width:0;height:0;}" +
                ".toggle-slider{position:absolute;inset:0;background:#d8d8d8;border-radius:21px;" +
                "transition:background-color 0.15s ease;}" +
                ".toggle-slider::before{content:'';position:absolute;width:15px;height:15px;left:3px;top:3px;" +
                "background:#fff;border-radius:50%;transition:transform 0.15s ease;" +
                "box-shadow:0 1px 3px rgba(0,0,0,0.35);}" +
                ".toggle-switch input:checked+.toggle-slider{background:#55c500;}" +
                ".toggle-switch input:checked+.toggle-slider::before{transform:translateX(17px);}" +
                ".toggle-text{user-select:none;}" +
                "body.knowledge-view-active{margin-left:0 !important;}" +
                "#knowledgeApp{display:flex;align-items:flex-start;gap:16px;background:#f5f5f5;padding:16px;" +
                "box-sizing:border-box;max-width:1320px;margin:0 auto;font-family:-apple-system," +
                "BlinkMacSystemFont,'Helvetica Neue',Arial,'Hiragino Kaku Gothic ProN','Hiragino Sans'," +
                "Meiryo,sans-serif;color:#292929;transition:max-width 0.15s ease;}" +
                "#knowledgeApp.is-wide-editor{max-width:2070px;}" +
                "#knowledgeTree{width:280px;flex:0 0 auto;background:#fff;border:1px solid #e6e6e6;" +
                "border-radius:6px;padding:14px;box-sizing:border-box;overflow-y:auto;}" +
                "#knowledgeEditor{flex:0 1 750px;max-width:750px;background:#fff;" +
                "border:1px solid #e6e6e6;border-radius:6px;padding:24px;box-sizing:border-box;" +
                "min-height:100vh;transition:max-width 0.15s ease,flex-basis 0.15s ease;}" +
                "#knowledgeEditor.is-wide{flex-basis:1500px;max-width:1500px;}" +
                "#knowledgeSidePanel{width:220px;flex:0 0 auto;display:flex;flex-direction:column;gap:16px;" +
                "position:sticky;top:16px;max-height:80vh;overflow-y:auto;font-size:11px;}" +
                ".knowledge-side-card{background:#fff;border:1px solid #e6e6e6;border-radius:6px;" +
                "padding:16px;box-sizing:border-box;}" +
                ".sidebar-section-title{font-size:10px;color:#a8a8a8;font-weight:bold;" +
                "text-transform:uppercase;letter-spacing:0.03em;border-bottom:1px solid #eee;" +
                "padding-bottom:4px;margin-bottom:8px;}" +
                ".toc-item{font-size:11px;padding:4px 0;color:#767676;cursor:pointer;line-height:1.4;}" +
                ".toc-item:hover{color:#55c500;}" +
                ".toc-item.is-active{color:#2f7d00;font-weight:bold;}" +
                ".toc-item.toc-level-1,.toc-item.toc-level-2{padding-left:0;}" +
                ".toc-item.toc-level-3{padding-left:12px;}" +
                ".toc-item.toc-level-4{padding-left:24px;}" +
                ".knowledge-add-item{display:inline-block;cursor:pointer;color:#55c500;" +
                "font-weight:bold;font-size:0.85em;padding:4px 0;}" +
                ".knowledge-add-item:hover{text-decoration:underline;}" +
                ".knowledge-search-row{margin-bottom:10px;}" +
                "#knowledgeTreeSearchInput{width:100%;box-sizing:border-box;padding:6px 8px;" +
                "border:1px solid #e6e6e6;border-radius:4px;font-size:0.85em;font-family:inherit;}" +
                "#knowledgeTreeSearchInput:focus{outline:none;border-color:#55c500;}" +
                ".knowledge-tag-filter-row{margin-bottom:10px;}" +
                ".tag-chip{display:inline-block;border:1px solid #d8d8d8;border-radius:12px;padding:2px 10px;" +
                "margin:0 4px 4px 0;font-size:0.75em;color:#767676;cursor:pointer;}" +
                ".tag-chip.is-active{background:#55c500;border-color:#55c500;color:#fff;}" +
                ".knowledge-empty,.knowledge-loading{color:#a8a8a8;font-size:0.85em;padding:4px 0;}" +
                ".knowledge-error{color:#d9534f;font-size:0.85em;padding:4px 0;}" +
                ".knowledge-item{cursor:pointer;padding:4px 6px;border-radius:4px;font-size:0.9em;flex:1 1 auto;}" +
                ".knowledge-item:hover{background:#f0faf0;}" +
                ".knowledge-item.is-selected{background:#e5f7e0;color:#2f7d00;font-weight:bold;}" +
                ".knowledge-item.is-unseen-update{font-weight:bold;}" +
                ".knowledge-tree-row{display:flex;align-items:center;padding:2px;border-radius:4px;}" +
                ".knowledge-tree-row:hover{background:#f5f5f5;}" +
                ".knowledge-tree-row:hover .knowledge-add-child{visibility:visible;}" +
                ".knowledge-tree-row.is-dragging{opacity:0.4;}" +
                ".knowledge-tree-row.drop-before{box-shadow:inset 0 2px 0 0 #55c500;}" +
                ".knowledge-tree-row.drop-after{box-shadow:inset 0 -2px 0 0 #55c500;}" +
                ".knowledge-tree-row.drop-inside{background:#e5f7e0;outline:1px dashed #55c500;}" +
                ".tree-toggle-icon{color:#55c500;font-size:0.75em;width:14px;flex:0 0 auto;cursor:pointer;" +
                "text-align:center;}" +
                ".tree-toggle-leaf{color:#d8d8d8;cursor:default;}" +
                ".knowledge-add-child{margin-left:4px;color:#55c500;font-weight:bold;cursor:pointer;" +
                "visibility:hidden;padding:0 4px;flex:0 0 auto;}" +
                "#knowledgeTitleRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;" +
                "border-bottom:2px solid #e6e6e6;margin-bottom:16px;padding-bottom:6px;}" +
                "#knowledgeTitleInput{flex:1 1 100%;min-width:0;font-size:1.6em;font-weight:bold;border:none;" +
                "padding:6px 2px;box-sizing:border-box;color:#292929;font-family:inherit;}" +
                "#knowledgeTitleInput:focus{outline:none;}" +
                "#knowledgeMetaRow{color:#a8a8a8;font-size:0.8em;margin-bottom:16px;}" +
                "#knowledgeTagChecks{margin-bottom:16px;}" +
                ".knowledge-tag-pill{display:inline-flex;align-items:center;background:#55c500;color:#fff;" +
                "border:1px solid #55c500;border-radius:16px;padding:3px 12px;margin:0 6px 6px 0;" +
                "font-size:11px;cursor:pointer;}" +
                ".knowledge-tag-pill:hover{opacity:0.85;}" +
                ".tag-add-item{display:inline-flex;align-items:center;cursor:pointer;color:#55c500;" +
                "font-weight:bold;font-size:10px;padding:3px 8px;}" +
                ".tag-add-item:hover{text-decoration:underline;}" +
                "#knowledgeBodyArea{display:block;}" +
                "#knowledgeBodyArea.is-split{display:flex;gap:16px;}" +
                "#knowledgeBodyArea.is-split #knowledgeBodyInput{width:50%;flex:1 1 50%;}" +
                "#knowledgeBodyArea.is-split #knowledgeBodyPreview{width:50%;flex:1 1 50%;" +
                "border-left:1px solid #e6e6e6;padding-left:16px;}" +
                "#knowledgeBodyInput{width:100%;height:55vh;box-sizing:border-box;padding:12px;" +
                "border:1px solid #e6e6e6;border-radius:4px;resize:vertical;font-size:0.95em;line-height:1.7;" +
                "color:#292929;font-family:inherit;}" +
                "#knowledgeBodyInput:focus{outline:none;border-color:#55c500;}" +
                ".mode-badge{font-size:0.7em;font-weight:bold;padding:2px 9px;border-radius:10px;flex:0 0 auto;}" +
                ".mode-badge.is-edit{background:#e8f0fe;color:#1a73e8;}" +
                ".mode-badge.is-preview{background:#e5f7e0;color:#2f7d00;}" +
                ".mode-badge.is-split{background:#fff3cd;color:#8a6d00;}" +
                "#knowledgeBodyModeSwitch{display:inline-flex;border:1px solid #55c500;border-radius:4px;" +
                "overflow:hidden;flex:0 0 auto;}" +
                ".mode-switch-btn{border:none;background:#fff;color:#55c500;padding:4px 10px;" +
                "font-size:0.8em;cursor:pointer;}" +
                ".mode-switch-btn+.mode-switch-btn{border-left:1px solid #55c500;}" +
                ".mode-switch-btn.is-active{background:#55c500;color:#fff;}" +
                ".knowledge-body-hint{color:#a8a8a8;font-size:0.75em;flex:0 0 auto;}" +
                "#knowledgeSearchBox{position:relative;flex:0 0 auto;display:inline-flex;align-items:center;" +
                "gap:4px;}" +
                "#knowledgeSearchToggle{border:none;background:none;cursor:pointer;color:#767676;" +
                "font-size:1em;padding:4px;}" +
                "#knowledgeSearchToggle:hover{color:#55c500;}" +
                "#knowledgeSearchInput{width:200px;box-sizing:border-box;padding:5px 8px;" +
                "border:1px solid #d8d8d8;border-radius:4px;font-size:0.85em;font-family:inherit;}" +
                "#knowledgeSearchInput:focus{outline:none;border-color:#55c500;}" +
                "#knowledgeSearchResults{display:none;position:absolute;top:100%;right:0;margin-top:4px;" +
                "width:280px;max-height:360px;overflow-y:auto;background:#fff;border:1px solid #d8d8d8;" +
                "border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:1000;font-size:0.8em;}" +
                "#knowledgeSearchResults.is-open{display:block;}" +
                ".search-result-group-label{padding:8px 12px 4px;color:#a8a8a8;font-size:0.75em;}" +
                ".search-result-item{padding:6px 12px;cursor:pointer;color:#292929;line-height:1.4;}" +
                ".search-result-item:hover{background:#f0faf0;}" +
                ".search-result-empty{padding:10px 12px;color:#a8a8a8;}" +
                "mark.search-highlight{background:#fff3b0;color:inherit;padding:0;}" +
                "#knowledgeBodyPreview{width:100%;max-width:765px;min-height:55vh;box-sizing:border-box;" +
                "padding:12px 2px;line-height:1.7;overflow:auto;}" +
                "#knowledgeBodyPreview h1,#knowledgeBodyPreview h2,#knowledgeBodyPreview h3{" +
                "border-bottom:1px solid #e6e6e6;padding-bottom:4px;}" +
                "#knowledgeBodyPreview pre{background:#f5f5f5;padding:10px;border-radius:4px;overflow:auto;}" +
                "#knowledgeBodyPreview code{background:#f5f5f5;padding:1px 4px;border-radius:3px;}" +
                "#knowledgeBodyPreview blockquote{border-left:3px solid #55c500;padding-left:10px;" +
                "color:#767676;margin:0;}" +
                "#knowledgeBodyPreview .mermaid{display:flex;justify-content:center;margin:12px 0;" +
                "background:#fff;}" +
                "#knowledgeSaveStatus{color:#a8a8a8;font-size:0.85em;}" +
                "#knowledgeSaveStatus.is-unsaved{color:#d9534f;font-weight:bold;}" +
                "#knowledgeSaveStatus.is-saved{color:#2f7d00;}" +
                "#knowledgeNativeEditButton{border:none;background:#55c500;color:#fff;margin-left:auto;" +
                "border-radius:4px;padding:6px 14px;cursor:pointer;font-size:0.85em;flex:0 0 auto;}" +
                "#knowledgeSaveButton{border:none;background:#55c500;color:#fff;" +
                "border-radius:4px;padding:6px 16px;cursor:pointer;font-size:0.85em;flex:0 0 auto;}" +
                "#knowledgeNativeEditButton:hover{background:#46a600;}" +
                "#knowledgeSaveButton:hover{background:#46a600;}" +
                "#knowledgeDeleteButton{color:#d9534f;background:#fff;border:1px solid #d9534f;" +
                "border-radius:4px;padding:6px 14px;cursor:pointer;font-size:0.85em;flex:0 0 auto;}" +
                "#knowledgeDeleteButton:hover{background:#d9534f;color:#fff;}" +
                "#knowledgeEmptyState{color:#a8a8a8;padding:16px;font-size:0.9em;}" +
                "#knowledgeContextMenu,#knowledgeTagPicker{position:absolute;z-index:1000;background:#fff;" +
                "border:1px solid #d8d8d8;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.15);" +
                "padding:4px 0;font-size:0.85em;min-width:160px;}" +
                ".context-menu-item{padding:6px 14px;cursor:pointer;color:#292929;white-space:nowrap;}" +
                ".context-menu-item:hover{background:#f0faf0;}" +
                ".context-menu-item.is-disabled{color:#c8c8c8;cursor:default;}" +
                ".context-menu-item.is-disabled:hover{background:none;}" +
                ".context-menu-danger{color:#d9534f;}" +
                ".context-menu-separator{border-top:1px solid #eee;margin:4px 0;}"
        }).appendTo("head");
    }

    function isViewEnabled() {
        var saved = window.localStorage.getItem(ENABLED_STORAGE_KEY);
        return saved === null ? true : saved === "1"; // 未設定時は既定でON
    }

    function applyViewParamOverride() {
        // リンク経由でON/OFFを明示的に指定できるようにする（?view=on / ?view=off）
        var viewParam = getQueryParam("view");
        if (viewParam === "on" || viewParam === "off") {
            window.localStorage.setItem(ENABLED_STORAGE_KEY, viewParam === "on" ? "1" : "0");
        }
    }

    function renderToggle() {
        var $toggle = $(
            '<label id="knowledgeViewToggleLabel">' +
            '<span class="toggle-switch">' +
            '<input type="checkbox" id="knowledgeViewToggle" />' +
            '<span class="toggle-slider"></span>' +
            '</span>' +
            '<span class="toggle-text">ナレッジビュー</span>' +
            '</label>'
        );
        $toggle.find("input").prop("checked", isViewEnabled()).on("change", function () {
            var enabled = $(this).is(":checked");
            window.localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? "1" : "0");
            applyViewState(enabled);
        });

        var $searchBox = $(
            '<div id="knowledgeSearchBox">' +
            '  <button type="button" id="knowledgeSearchToggle" title="検索">🔍</button>' +
            '  <input type="text" id="knowledgeSearchInput" placeholder="検索" />' +
            '  <div id="knowledgeSearchResults"></div>' +
            '</div>'
        );

        var $controls = $('<div id="knowledgeHeaderControls"></div>').append($searchBox).append($toggle);
        // パンくずリストの行内・右上に配置するため、その行を基準位置にして中に追加する
        $("#Breadcrumb").closest("nav").css("position", "relative").append($controls);
        bindKnowledgeSearchBox();
    }

    function applyViewState(enabled) {
        $("body").toggleClass("knowledge-view-active", enabled);
        $("#knowledgeSearchBox").toggle(enabled); // 検索窓はナレッジビュー有効時のみ表示
        if (enabled) {
            // パンくずリスト以外の既定表示(ヘッダー、上へ/サイト一覧、戻るボタン等)を非表示にする
            $("#Header, #Guide, #Warnings, #MainForm, #MainCommandsContainer, #Message").hide();
            if (!built) {
                renderLayout();
                loadAll();
                built = true;
            } else {
                $("#knowledgeApp").show();
            }
        } else {
            $("#Header, #Guide, #Warnings, #MainForm, #MainCommandsContainer, #Message").show();
            $("#knowledgeApp").hide();
            closeKnowledgeSearch();
        }
    }

    function renderLayout() {
        if ($("#knowledgeApp").length) return;

        var $app = $(
            '<div id="knowledgeApp">' +
            '  <div id="knowledgeTree"></div>' +
            '  <div id="knowledgeEditor"></div>' +
            '  <div id="knowledgeSidePanel">' +
            '    <div class="knowledge-side-card">' +
            '      <div class="sidebar-section-title">タグ</div>' +
            '      <div id="knowledgeTagChecks"></div>' +
            '    </div>' +
            '    <div class="knowledge-side-card" id="knowledgeTocSection">' +
            '      <div class="sidebar-section-title">見出し</div>' +
            '      <div id="knowledgeTocList"></div>' +
            '    </div>' +
            '  </div>' +
            '</div>'
        );
        // パンくずリストの行の直後に挿入する
        $("#Breadcrumb").closest("nav").after($app);
        renderEmptyEditor();
    }

    function loadAll() {
        $p.apiGet({
            id: TAG_SITE_ID,
            data: {},
            done: function (data) {
                var tags = (data && data.Response && data.Response.Data) || [];
                tagTitleById = {};
                tags.forEach(function (tag) {
                    tagTitleById[tag.ResultId] = tag.Title;
                });
                refreshKnowledgeList(restoreLastOpenedKnowledge);
            },
            fail: function (err) {
                console.error("タグ一覧の取得に失敗しました", err);
                refreshKnowledgeList(restoreLastOpenedKnowledge);
            }
        });
    }

    function restoreLastOpenedKnowledge() {
        // URLに ?knowledge=ID があればそれを優先して開く（コピーしたリンク経由でのアクセス）
        var linkedId = getQueryParam("knowledge");
        if (linkedId && knowledgeById[linkedId]) {
            expandAncestorsAndOpen(linkedId);
            return;
        }
        // なければ前回開いていたページを自動で開く（削除済みなら何もしない）
        var lastId = window.localStorage.getItem(LAST_OPENED_STORAGE_KEY);
        if (!lastId || !knowledgeById[lastId]) return;
        expandAncestorsAndOpen(lastId);
    }

    function expandAncestorsAndOpen(resultId) {
        var item = knowledgeById[resultId];
        while (item && item.ParentId) {
            expandedIds[item.ParentId] = true;
            item = knowledgeById[item.ParentId];
        }
        renderSidebar();
        openKnowledge(Number(resultId));
    }

    function getQueryParam(name) {
        return new URLSearchParams(window.location.search).get(name);
    }

    function refreshKnowledgeList(onDone) {
        $("#knowledgeTree").html('<div class="knowledge-loading">読み込み中...</div>');
        $p.apiGet({
            id: KNOWLEDGE_SITE_ID,
            data: {},
            done: function (data) {
                var records = (data && data.Response && data.Response.Data) || [];
                buildKnowledgeMaps(records);
                renderSidebar();
                if (onDone) onDone();
            },
            fail: function (err) {
                $("#knowledgeTree").html('<div class="knowledge-error">取得に失敗しました</div>');
                console.error("ナレッジ一覧の取得に失敗しました", err);
            }
        });
    }

    function buildKnowledgeMaps(records) {
        knowledgeById = {};
        childrenByParent = {};
        records.forEach(function (rec) {
            var classB = rec.ClassHash && rec.ClassHash.ClassB;
            var parentId = classB ? String(classB) : "";
            if (parentId === String(rec.ResultId)) parentId = ""; // 自己参照はルート扱い
            knowledgeById[rec.ResultId] = {
                ResultId: rec.ResultId,
                Title: rec.Title,
                ParentId: parentId,
                Order: parseOrderValue(rec.NumHash && rec.NumHash.NumA), // 並び順（Order列/NumA）
                UpdatedTime: rec.UpdatedTime,
                Updator: rec.Updator
            };
        });
        Object.keys(knowledgeById).forEach(function (id) {
            var item = knowledgeById[id];
            var parentKey = item.ParentId;
            if (parentKey && !knowledgeById[parentKey]) parentKey = ""; // 親が存在しない場合はルート扱い
            if (!childrenByParent[parentKey]) childrenByParent[parentKey] = [];
            childrenByParent[parentKey].push(item.ResultId);
        });
    }

    function byTitle(a, b) {
        var ta = (knowledgeById[a] && knowledgeById[a].Title) || "";
        var tb = (knowledgeById[b] && knowledgeById[b].Title) || "";
        return ta.localeCompare(tb, "ja");
    }

    function byOrder(a, b) {
        // 並び順はOrder列(NumA)を優先し、同値の場合のみタイトル順にフォールバックする
        var oa = (knowledgeById[a] && knowledgeById[a].Order) || 0;
        var ob = (knowledgeById[b] && knowledgeById[b].Order) || 0;
        if (oa !== ob) return oa - ob;
        return byTitle(a, b);
    }

    function parseOrderValue(value) {
        var num = Number(value);
        return isFinite(num) ? num : 0;
    }

    function getNextOrderValue(parentId) {
        // 指定した親の子の末尾に追加する場合のOrder値（既存最大値+10）を返す
        var siblings = childrenByParent[parentId || ""] || [];
        var maxOrder = 0;
        siblings.forEach(function (id) {
            var item = knowledgeById[id];
            if (item && item.Order > maxOrder) maxOrder = item.Order;
        });
        return maxOrder + 10;
    }

    function renderSidebar() {
        var $tree = $("#knowledgeTree").empty();
        $tree.append(renderSidebarSearchBox());
        $tree.append(renderSidebarTagFilterRow());
        $tree.append('<div id="knowledgeListArea"></div>');
        renderSidebarList();
    }

    function renderSidebarSearchBox() {
        var $box = $(
            '<div class="knowledge-search-row">' +
            '<input type="text" id="knowledgeTreeSearchInput" placeholder="ページ名で検索" />' +
            '</div>'
        );
        $box.find("input").val(sidebarSearchKeyword).on("input", function () {
            var $input = $(this);
            clearTimeout(sidebarSearchDebounceTimer);
            sidebarSearchDebounceTimer = setTimeout(function () {
                sidebarSearchKeyword = $input.val();
                renderSidebarList(); // 入力欄自体は再生成せず、一覧部分だけ更新してフォーカスを保つ
            }, 300);
        });
        return $box;
    }

    function renderSidebarTagFilterRow() {
        // タグはナレッジに付与する検索補助情報として、絞り込み用のチップで表示する
        var $row = $('<div class="knowledge-tag-filter-row"></div>');
        Object.keys(tagTitleById).forEach(function (tagId) {
            var isActive = activeSidebarTagFilter === String(tagId);
            var $chip = $(
                '<span class="tag-chip' + (isActive ? " is-active" : "") + '">' +
                escapeHtml(tagTitleById[tagId]) +
                '</span>'
            );
            $chip.on("click", function () {
                if (isActive) {
                    activeSidebarTagFilter = null;
                    tagFilterResultIds = null;
                    renderSidebar();
                    return;
                }
                activeSidebarTagFilter = String(tagId);
                fetchTagFilterResultIds(activeSidebarTagFilter, renderSidebar);
            });
            $row.append($chip);
        });
        return $row;
    }

    function fetchTagFilterResultIds(tagId, onDone) {
        // タグでの絞り込みはクリック時にColumnFilterHashでサーバー側に問い合わせる（一覧取得にClassAを含めないため）
        $p.apiGet({
            id: KNOWLEDGE_SITE_ID,
            data: { View: { ColumnFilterHash: { ClassA: JSON.stringify([tagId]) } } },
            done: function (data) {
                var records = (data && data.Response && data.Response.Data) || [];
                tagFilterResultIds = records.map(function (rec) { return rec.ResultId; });
                onDone();
            },
            fail: function (err) {
                console.error("タグ絞り込みの取得に失敗しました", err);
                tagFilterResultIds = [];
                onDone();
            }
        });
    }

    function renderSidebarList() {
        var $listArea = $("#knowledgeListArea").empty();
        if (sidebarSearchKeyword || activeSidebarTagFilter) {
            renderSidebarFilteredList($listArea);
        } else {
            renderTreeArea($listArea);
        }
    }

    function renderSidebarFilteredList($container) {
        var keyword = sidebarSearchKeyword.trim().toLowerCase();
        var matches = Object.keys(knowledgeById)
            .map(Number)
            .filter(function (id) {
                var item = knowledgeById[id];
                var matchesTag = !activeSidebarTagFilter ||
                    (tagFilterResultIds !== null && tagFilterResultIds.indexOf(id) !== -1);
                var matchesKeyword = !keyword || item.Title.toLowerCase().indexOf(keyword) !== -1;
                return matchesTag && matchesKeyword;
            })
            .sort(byTitle);

        if (matches.length === 0) {
            $container.append('<div class="knowledge-empty">該当するナレッジはありません</div>');
            return;
        }
        matches.forEach(function (id) {
            var item = knowledgeById[id];
            var $item = $(
                '<div class="knowledge-item' + (isUnseenUpdate(item) ? " is-unseen-update" : "") + '" ' +
                'data-result-id="' + id + '">' + escapeHtml(item.Title) + '</div>'
            );
            $item.on("click", function () {
                if (!confirmDiscardIfDirty()) return;
                openKnowledge(id);
            });
            $item.on("contextmenu", function (e) {
                e.preventDefault();
                showContextMenu(e.pageX, e.pageY, id);
            });
            $container.append($item);
        });
    }

    function renderTreeArea($container) {
        if (Object.keys(knowledgeById).length === 0) {
            var $addRoot = $('<div class="knowledge-add-item">＋ 新規作成</div>');
            $addRoot.on("click", function () {
                createKnowledge("", getNextOrderValue(""));
            });
            $container.append($addRoot);
        }

        var roots = (childrenByParent[""] || []).slice().sort(byOrder);
        if (roots.length === 0) {
            $container.append('<div class="knowledge-empty">ナレッジがありません</div>');
        }
        roots.forEach(function (id) {
            $container.append(renderTreeNode(id, 0));
        });
        bindTreeContainerDragEvents($container);
    }

    function renderTreeNode(resultId, depth) {
        var item = knowledgeById[resultId];
        var childIds = (childrenByParent[String(resultId)] || []).slice().sort(byOrder);
        var hasChildren = childIds.length > 0;
        var isExpanded = !!expandedIds[resultId];

        var $node = $('<div class="knowledge-tree-node" style="padding-left:' + (depth * 16) + 'px;"></div>');
        var $row = $(
            '<div class="knowledge-tree-row" draggable="true">' +
            (hasChildren
                ? '<span class="tree-toggle-icon">' + (isExpanded ? "▼" : "▶") + '</span>'
                : '<span class="tree-toggle-icon tree-toggle-leaf">・</span>') +
            '<span class="knowledge-item' + (isUnseenUpdate(item) ? " is-unseen-update" : "") + '" ' +
            'data-result-id="' + resultId + '">' + escapeHtml(item.Title) + '</span>' +
            '<span class="knowledge-add-child" title="子ページを追加">＋</span>' +
            '</div>'
        );

        $row.find(".tree-toggle-icon").on("click", function () {
            if (!hasChildren) return;
            expandedIds[resultId] = !isExpanded;
            renderSidebar();
        });
        $row.find(".knowledge-item").on("click", function () {
            if (!confirmDiscardIfDirty()) return;
            openKnowledge(resultId);
        });
        $row.find(".knowledge-add-child").on("click", function (e) {
            e.stopPropagation();
            expandedIds[resultId] = true;
            createKnowledge(String(resultId), getNextOrderValue(String(resultId)));
        });
        $row.on("contextmenu", function (e) {
            e.preventDefault();
            showContextMenu(e.pageX, e.pageY, resultId);
        });
        bindTreeRowDragEvents($row, resultId);

        $node.append($row);

        if (hasChildren && isExpanded) {
            var $children = $('<div class="knowledge-tree-children"></div>');
            childIds.forEach(function (childId) {
                $children.append(renderTreeNode(childId, depth + 1));
            });
            $node.append($children);
        }

        return $node;
    }

    function bindTreeRowDragEvents($row, resultId) {
        $row.on("dragstart", function (e) {
            draggedResultId = resultId;
            $row.addClass("is-dragging");
            e.originalEvent.dataTransfer.effectAllowed = "move";
            e.originalEvent.dataTransfer.setData("text/plain", String(resultId));
        });
        $row.on("dragend", function () {
            draggedResultId = null;
            clearDropIndicators();
        });
        $row.on("dragover", function (e) {
            if (draggedResultId === null || draggedResultId === resultId) return;
            e.preventDefault();
            var rect = this.getBoundingClientRect();
            var ratio = (e.originalEvent.clientY - rect.top) / rect.height;
            var position = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
            $row.data("dropPosition", position);
            $row.removeClass("drop-before drop-after drop-inside").addClass("drop-" + position);
        });
        $row.on("dragleave", function () {
            $row.removeClass("drop-before drop-after drop-inside");
        });
        $row.on("drop", function (e) {
            if (draggedResultId === null || draggedResultId === resultId) return;
            e.preventDefault();
            e.stopPropagation();
            var position = $row.data("dropPosition") || "inside";
            handleTreeDrop(draggedResultId, resultId, position);
            clearDropIndicators();
        });
    }

    function bindTreeContainerDragEvents($container) {
        // ツリーの空白部分にドロップした場合は最上位（親なし）へ移動する
        // このコンテナDOMは検索クリア時など再生成されずに使い回されることがあるため、
        // 名前空間付きイベントで一旦解除してから登録し、ハンドラの多重登録を防ぐ
        $container.off("dragover.knowledgeTreeContainer drop.knowledgeTreeContainer");
        $container.on("dragover.knowledgeTreeContainer", function (e) {
            if (draggedResultId === null) return;
            e.preventDefault();
        });
        $container.on("drop.knowledgeTreeContainer", function (e) {
            if (draggedResultId === null) return;
            e.preventDefault();
            handleTreeDrop(draggedResultId, null, "root");
            clearDropIndicators();
        });
    }

    function clearDropIndicators() {
        $(".knowledge-tree-row").removeClass("is-dragging drop-before drop-after drop-inside");
    }

    function isDescendantOf(nodeId, ancestorId) {
        var current = knowledgeById[nodeId];
        while (current && current.ParentId) {
            if (Number(current.ParentId) === Number(ancestorId)) return true;
            current = knowledgeById[current.ParentId];
        }
        return false;
    }

    var ORDER_GAP_EPSILON = 1e-6; // 前後のOrder差がこれ未満になったら振り直し(リバランス)する

    function computeOrderBetween(prevOrder, nextOrder) {
        if (prevOrder == null && nextOrder == null) return 10;
        if (prevOrder == null) return nextOrder / 2;      // 先頭に挿入
        if (nextOrder == null) return prevOrder + 10;     // 末尾に挿入
        return (prevOrder + nextOrder) / 2;               // 間に挿入
    }

    function getOrderForInsertAfter(resultId) {
        // 指定したページの直後（次の兄弟の手前）に挿入する場合のOrder値を返す
        var item = knowledgeById[resultId];
        if (!item) return getNextOrderValue("");
        var siblings = (childrenByParent[item.ParentId || ""] || []).slice().sort(byOrder);
        var index = siblings.indexOf(Number(resultId));
        var nextId = index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null;
        var nextOrder = nextId !== null ? knowledgeById[nextId].Order : null;
        return computeOrderBetween(item.Order, nextOrder);
    }

    function handleTreeDrop(draggedId, targetId, position) {
        draggedId = Number(draggedId);
        targetId = targetId === null ? null : Number(targetId);
        if (!knowledgeById[draggedId]) return;
        if (targetId !== null && (draggedId === targetId || isDescendantOf(targetId, draggedId))) return;

        var newParentId;
        if (position === "root") {
            newParentId = "";
        } else if (position === "inside") {
            newParentId = String(targetId);
            expandedIds[targetId] = true;
        } else {
            var targetItem = knowledgeById[targetId];
            newParentId = targetItem ? (targetItem.ParentId || "") : "";
        }

        // 兄弟(移動対象を除く)の並びの中で、挿入位置の前後にあたる項目だけを見る
        var siblingIds = (childrenByParent[newParentId] || [])
            .filter(function (id) { return id !== draggedId; })
            .slice().sort(byOrder);

        var prevId = null;
        var nextId = null;
        if (position === "before" || position === "after") {
            var targetIndex = siblingIds.indexOf(targetId);
            var insertIndex = position === "before" ? targetIndex : targetIndex + 1;
            if (insertIndex < 0) insertIndex = siblingIds.length;
            prevId = insertIndex > 0 ? siblingIds[insertIndex - 1] : null;
            nextId = insertIndex < siblingIds.length ? siblingIds[insertIndex] : null;
        } else {
            prevId = siblingIds.length > 0 ? siblingIds[siblingIds.length - 1] : null; // inside/rootは末尾に追加
        }

        var prevOrder = prevId !== null ? knowledgeById[prevId].Order : null;
        var nextOrder = nextId !== null ? knowledgeById[nextId].Order : null;

        if (prevOrder !== null && nextOrder !== null && (nextOrder - prevOrder) < ORDER_GAP_EPSILON) {
            // 隙間が枯渇した場合のみ、そのリスト全体を10刻みで振り直す（レアケース）
            var rebuiltIds = siblingIds.slice();
            rebuiltIds.splice(siblingIds.indexOf(prevId) + 1, 0, draggedId);
            rebalanceSiblingOrder(rebuiltIds, newParentId, draggedId);
            return;
        }

        moveKnowledgeTo(draggedId, newParentId, computeOrderBetween(prevOrder, nextOrder));
    }

    function moveKnowledgeTo(draggedId, newParentId, newOrder) {
        // 前後の中間値をOrderに設定するため、動かした1件だけを更新すればよい（他の兄弟は変更不要）
        var item = knowledgeById[draggedId];
        var data = { NumHash: { NumA: newOrder } };
        if (!item || String(item.ParentId) !== String(newParentId)) {
            data.ClassHash = { ClassB: newParentId };
        }
        $p.apiUpdate({
            id: draggedId,
            data: data,
            done: function () {
                refreshKnowledgeList(function () {
                    if (currentResultId === draggedId) openKnowledge(draggedId);
                });
            },
            fail: function (err) {
                console.error("並び順の更新に失敗しました", err);
            }
        });
    }

    function rebalanceSiblingOrder(orderedIds, newParentId, draggedId) {
        var pending = 0;
        function checkDone() {
            if (pending === 0) {
                refreshKnowledgeList(function () {
                    if (currentResultId === draggedId) openKnowledge(draggedId);
                });
            }
        }
        orderedIds.forEach(function (id, index) {
            var newOrder = (index + 1) * 10;
            var item = knowledgeById[id];
            var parentChanged = id === draggedId && item && String(item.ParentId) !== String(newParentId);
            var orderChanged = !item || item.Order !== newOrder;
            if (!parentChanged && !orderChanged) return;

            var data = { NumHash: { NumA: newOrder } };
            if (parentChanged) data.ClassHash = { ClassB: newParentId };

            pending++;
            $p.apiUpdate({
                id: id,
                data: data,
                done: function () { pending--; checkDone(); },
                fail: function (err) {
                    console.error("並び順の振り直しに失敗しました", err);
                    pending--; checkDone();
                }
            });
        });
        checkDone();
    }

    function showContextMenu(x, y, resultId) {
        closeContextMenu();
        var item = knowledgeById[resultId];
        var canPromote = !!(item && item.ParentId);
        var canDemote = getPreviousSiblingId(resultId) !== null;

        var $menu = $(
            '<div id="knowledgeContextMenu">' +
            '<div class="context-menu-item" data-action="newPage">＋ 新しいページ</div>' +
            '<div class="context-menu-item' + (canDemote ? "" : " is-disabled") + '" data-action="demote">' +
            '→ サブページにする</div>' +
            '<div class="context-menu-item' + (canPromote ? "" : " is-disabled") + '" data-action="promote">' +
            '← サブページのレベルを上げる</div>' +
            '<div class="context-menu-separator"></div>' +
            '<div class="context-menu-item" data-action="copyLink">このページへのリンクをコピー</div>' +
            '<div class="context-menu-item" data-action="openNewTab">新しいタブで開く</div>' +
            '<div class="context-menu-separator"></div>' +
            '<div class="context-menu-item context-menu-danger" data-action="delete">ページの削除</div>' +
            '</div>'
        );
        $menu.css({ left: x + "px", top: y + "px" });
        $menu.on("click", ".context-menu-item", function () {
            if ($(this).hasClass("is-disabled")) return;
            handleContextMenuAction($(this).data("action"), resultId);
            closeContextMenu();
        });
        $("body").append($menu);
        clampMenuPosition($menu, x, y); // 画面下部/右端で見切れないよう位置を補正する
        setTimeout(function () {
            $(document).on("click.knowledgeContextMenu contextmenu.knowledgeContextMenu", closeContextMenu);
        }, 0);
    }

    function clampMenuPosition($menu, x, y) {
        var menuWidth = $menu.outerWidth();
        var menuHeight = $menu.outerHeight();
        var maxLeft = $(window).scrollLeft() + $(window).width() - menuWidth - 4;
        var maxTop = $(window).scrollTop() + $(window).height() - menuHeight - 4;
        var left = Math.min(x, Math.max(4, maxLeft));
        var top = Math.min(y, Math.max(4, maxTop));
        $menu.css({ left: left + "px", top: top + "px" });
    }

    function closeContextMenu() {
        $("#knowledgeContextMenu").remove();
        $(document).off("click.knowledgeContextMenu contextmenu.knowledgeContextMenu");
    }

    function handleContextMenuAction(action, resultId) {
        var item = knowledgeById[resultId];
        if (action === "newPage") {
            createKnowledge(item ? item.ParentId : "", getOrderForInsertAfter(resultId));
        } else if (action === "demote") {
            demoteKnowledge(resultId);
        } else if (action === "promote") {
            promoteKnowledge(resultId);
        } else if (action === "copyLink") {
            copyKnowledgeLink(resultId);
        } else if (action === "openNewTab") {
            window.open(getKnowledgeViewLink(resultId), "_blank");
        } else if (action === "delete") {
            deleteKnowledgeById(resultId);
        }
    }

    function getPreviousSiblingId(resultId) {
        // 兄弟ページ（同じ親を持つページ）の並び順で直前にあたるページIDを返す。無ければnull。
        var item = knowledgeById[resultId];
        if (!item) return null;
        var siblings = (childrenByParent[item.ParentId || ""] || []).slice().sort(byOrder);
        var index = siblings.indexOf(Number(resultId));
        if (index <= 0) return null;
        return siblings[index - 1];
    }

    function demoteKnowledge(resultId) {
        // 選択したページを、直前の兄弟ページのサブページにする（レベルを下げる）
        var previousSiblingId = getPreviousSiblingId(resultId);
        if (previousSiblingId === null) return;
        var newParentId = String(previousSiblingId);

        $p.apiUpdate({
            id: resultId,
            data: { ClassHash: { ClassB: newParentId }, NumHash: { NumA: getNextOrderValue(newParentId) } },
            done: function () {
                expandedIds[newParentId] = true;
                refreshKnowledgeList(function () {
                    if (currentResultId === resultId) openKnowledge(resultId);
                });
            },
            fail: function (err) {
                console.error("サブページ化に失敗しました", err);
            }
        });
    }

    function promoteKnowledge(resultId) {
        var item = knowledgeById[resultId];
        if (!item || !item.ParentId) return; // 最上位のページは昇格不可
        var parent = knowledgeById[item.ParentId];
        var newParentId = (parent && parent.ParentId) ? parent.ParentId : "";

        $p.apiUpdate({
            id: resultId,
            data: { ClassHash: { ClassB: newParentId }, NumHash: { NumA: getNextOrderValue(newParentId) } },
            done: function () {
                refreshKnowledgeList(function () {
                    if (currentResultId === resultId) openKnowledge(resultId);
                });
            },
            fail: function (err) {
                console.error("サブページのレベル変更に失敗しました", err);
            }
        });
    }

    function getKnowledgeLink(resultId) {
        return window.location.origin + "/items/" + resultId + "/edit";
    }

    function getKnowledgeViewLink(resultId) {
        // ナレッジビューをONにした状態でフォルダ画面を開き、該当ページを自動で選択・表示するURL
        return window.location.origin + "/items/" + FOLDER_SITE_ID + "/index?knowledge=" + resultId + "&view=on";
    }

    function copyKnowledgeLink(resultId) {
        var url = getKnowledgeViewLink(resultId);
        var fallbackCopy = function () {
            var $temp = $("<textarea></textarea>").val(url).appendTo("body").select();
            document.execCommand("copy");
            $temp.remove();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).catch(fallbackCopy);
        } else {
            fallbackCopy();
        }
    }

    function confirmDiscardIfDirty() {
        if (!isDirty) return true;
        if (!window.confirm("保存されていない変更があります。保存せずに移動しますか？")) return false;
        isDirty = false;
        return true;
    }

    function openKnowledge(resultId) {
        $p.apiGet({
            id: resultId,
            data: {},
            done: function (data) {
                var rec = (data && data.Response && data.Response.Data && data.Response.Data[0]) || null;
                if (rec) {
                    renderEditor(rec);
                    markKnowledgeAsSeen(resultId, rec.UpdatedTime);
                    $(".knowledge-item").removeClass("is-selected");
                    $('.knowledge-item[data-result-id="' + resultId + '"]').removeClass("is-unseen-update")
                        .addClass("is-selected");
                    window.localStorage.setItem(LAST_OPENED_STORAGE_KEY, String(resultId));
                }
            },
            fail: function (err) {
                console.error("ナレッジの取得に失敗しました", err);
            }
        });
    }

    function markKnowledgeAsSeen(resultId, updatedTime) {
        seenTimeByResultId[resultId] = updatedTime;
        window.localStorage.setItem(SEEN_TIMES_STORAGE_KEY, JSON.stringify(seenTimeByResultId));
    }

    function isUnseenUpdate(item) {
        var seenTime = seenTimeByResultId[item.ResultId];
        return !!seenTime && !!item.UpdatedTime && new Date(item.UpdatedTime) > new Date(seenTime);
    }

    function renderEditor(rec) {
        currentResultId = rec.ResultId;
        isDirty = false;

        var selectedTagIds = parseClassAIds(rec.ClassHash && rec.ClassHash.ClassA);

        var $editor = $(
            '<div id="knowledgeTitleRow">' +
            '    <input type="text" id="knowledgeTitleInput" placeholder="タイトル" />' +
            '    <span id="knowledgeBodyModeLabel" class="mode-badge"></span>' +
            '    <div id="knowledgeBodyModeSwitch">' +
            '      <button type="button" class="mode-switch-btn" data-mode="edit">エディタ</button>' +
            '      <button type="button" class="mode-switch-btn" data-mode="preview">プレビュー</button>' +
            '      <button type="button" class="mode-switch-btn" data-mode="split">同時表示</button>' +
            '    </div>' +
            '    <span class="knowledge-body-hint">Ctrl+Shift+Vで順に切替</span>' +
            '    <button type="button" id="knowledgeNativeEditButton" title="プリザンターの編集画面を開く">✏️編集画面を開く</button>' +
            '    <button type="button" id="knowledgeSaveButton">保存</button>' +
            '    <button type="button" id="knowledgeDeleteButton">削除</button>' +
            '</div>' +
            '<div id="knowledgeMetaRow">' +
            '    更新日時: <span id="knowledgeUpdatedTime"></span>　' +
            '    更新者: <span id="knowledgeUpdator"></span>　' +
            '    <span id="knowledgeSaveStatus"></span>' +
            '</div>' +
            '<div id="knowledgeBodyArea">' +
            '    <textarea id="knowledgeBodyInput" placeholder="本文を入力...(Markdown記法)"></textarea>' +
            '    <div id="knowledgeBodyPreview" style="display:none;"></div>' +
            '</div>'
        );

        $("#knowledgeEditor").empty().append($editor);
        $("#knowledgeTitleInput").val(rec.Title || "");
        $("#knowledgeBodyInput").val(ensureMarkdownMarker(rec.Body || ""));
        knownServerBody = ensureMarkdownMarker(rec.Body || "");
        renderMetaRow(rec.UpdatedTime, rec.Updator);

        renderTags(selectedTagIds);

        $("#knowledgeTitleInput, #knowledgeBodyInput").on("input", function () {
            markDirty();
            if (bodyViewMode === "split") renderBodyPreview();
        });
        $("#knowledgeBodyInput").on("paste", handleBodyPaste);
        $("#knowledgeNativeEditButton").on("click", function () {
            window.open(getKnowledgeLink(rec.ResultId), "_blank");
        });
        $("#knowledgeSaveButton").on("click", saveCurrentKnowledge);
        $("#knowledgeDeleteButton").on("click", deleteCurrentKnowledge);
        $("#knowledgeBodyModeSwitch").on("click", ".mode-switch-btn", function () {
            setBodyMode($(this).data("mode"));
        });
        var isBodyBlank = stripMarkdownMarker(rec.Body || "").trim() === "";
        setBodyMode(isBodyBlank ? "edit" : "preview"); // 本文が空/マーカーのみの場合はエディタモードにする
    }

    function bindKnowledgeSearchBox() {
        var searchDebounceTimer = null;

        $("#knowledgeSearchToggle").on("click", function (e) {
            e.stopPropagation();
            $("#knowledgeSearchInput").focus();
        });
        $("#knowledgeSearchInput").on("input", function () {
            var $input = $(this);
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(function () {
                var keyword = $input.val().trim();
                if (!keyword) {
                    $("#knowledgeSearchResults").removeClass("is-open").empty();
                    return;
                }
                searchKnowledge(keyword, function (results) {
                    if ($input.val().trim() !== keyword) return; // 待っている間に入力が変わっていたら破棄
                    renderSearchResults(results, keyword);
                });
            }, 300);
        });
        $("#knowledgeSearchInput").on("keydown", function (e) {
            if (e.key === "Escape") {
                $(this).val("");
                closeKnowledgeSearch();
            }
        });
        $("#knowledgeSearchBox").on("click", function (e) {
            e.stopPropagation();
        });
    }

    function closeKnowledgeSearch() {
        $("#knowledgeSearchResults").removeClass("is-open").empty();
    }

    function searchKnowledge(keyword, callback) {
        // タグ・タイトル・本文を対象に検索する（タグ名の一致はタイトル側の一致として扱う）。
        // Body/ClassAは一覧キャッシュに保持していないため、検索実行時に都度apiGetで取得する。
        var kw = keyword.toLowerCase();
        $p.apiGet({
            id: KNOWLEDGE_SITE_ID,
            data: {},
            done: function (data) {
                var records = (data && data.Response && data.Response.Data) || [];
                var titleMatches = [];
                var bodyMatches = [];
                records.forEach(function (rec) {
                    var tagIds = parseClassAIds(rec.ClassHash && rec.ClassHash.ClassA);
                    var tagText = tagIds.map(function (tagId) { return tagTitleById[tagId] || ""; }).join(" ");
                    var titleHay = ((rec.Title || "") + " " + tagText).toLowerCase();
                    var body = stripMarkdownMarker(rec.Body || "");
                    var item = { ResultId: rec.ResultId, Title: rec.Title, Body: body };
                    if (titleHay.indexOf(kw) !== -1) {
                        titleMatches.push(item);
                    } else if (body.toLowerCase().indexOf(kw) !== -1) {
                        bodyMatches.push(item);
                    }
                });
                callback({
                    titleMatches: titleMatches.sort(compareByTitleText),
                    bodyMatches: bodyMatches.sort(compareByTitleText)
                });
            },
            fail: function (err) {
                console.error("検索用のナレッジ取得に失敗しました", err);
                callback({ titleMatches: [], bodyMatches: [] });
            }
        });
    }

    function compareByTitleText(a, b) {
        return (a.Title || "").localeCompare(b.Title || "", "ja");
    }

    function renderSearchResults(results, keyword) {
        var $box = $("#knowledgeSearchResults").empty();
        if (results.titleMatches.length === 0 && results.bodyMatches.length === 0) {
            $box.append('<div class="search-result-empty">一致するナレッジがありません</div>');
        } else {
            if (results.titleMatches.length > 0) {
                $box.append(
                    '<div class="search-result-group-label">タイトル/タグ内の一致: ' +
                    results.titleMatches.length + '件</div>'
                );
                results.titleMatches.forEach(function (item) {
                    appendSearchResultItem($box, item, keyword);
                });
            }
            if (results.bodyMatches.length > 0) {
                $box.append(
                    '<div class="search-result-group-label">本文内の一致: ' +
                    results.bodyMatches.length + '件</div>'
                );
                results.bodyMatches.forEach(function (item) {
                    var snippet = getSearchSnippet(item.Body || "", keyword, 20);
                    appendSearchResultItem($box, item, keyword, snippet);
                });
            }
        }
        $box.addClass("is-open");
    }

    function appendSearchResultItem($box, item, keyword, snippet) {
        var html = highlightMatch(item.Title, keyword);
        if (snippet) {
            html += '<br><span style="color:#a8a8a8;">' + highlightMatch(snippet, keyword) + '</span>';
        }
        var $result = $('<div class="search-result-item">' + html + '</div>');
        $result.on("click", function () {
            closeKnowledgeSearch();
            selectAndOpenKnowledge(item.ResultId);
        });
        $box.append($result);
    }

    function selectAndOpenKnowledge(resultId) {
        if (!confirmDiscardIfDirty()) return;
        var item = knowledgeById[resultId];
        while (item && item.ParentId) {
            expandedIds[item.ParentId] = true;
            item = knowledgeById[item.ParentId];
        }
        refreshKnowledgeList(function () {
            openKnowledge(resultId);
        });
    }

    function getSearchSnippet(text, keyword, radius) {
        var idx = text.toLowerCase().indexOf(keyword.toLowerCase());
        if (idx === -1) return text.slice(0, radius * 2);
        var start = Math.max(0, idx - radius);
        var end = Math.min(text.length, idx + keyword.length + radius);
        return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    }

    function escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function highlightMatch(text, keyword) {
        var safeText = escapeHtml(text);
        if (!keyword) return safeText;
        var pattern = new RegExp("(" + escapeRegExp(escapeHtml(keyword)) + ")", "ig");
        return safeText.replace(pattern, '<mark class="search-highlight">$1</mark>');
    }

    function ensureMarkdownMarker(body) {
        // 本文の先頭に[md]マーカーを付与する（追加済みの場合は何もしない）
        return body.indexOf(MARKDOWN_MARKER) === 0 ? body : MARKDOWN_MARKER + "\n" + body;
    }

    function stripMarkdownMarker(body) {
        if (body.indexOf(MARKDOWN_MARKER) !== 0) return body;
        return body.slice(MARKDOWN_MARKER.length).replace(/^\n/, "");
    }

    function handleBodyPaste(e) {
        var clipboardData = (e.originalEvent || e).clipboardData;
        var items = clipboardData && clipboardData.items;
        if (!items) return;

        var imageItem = null;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type && items[i].type.indexOf("image/") === 0) {
                imageItem = items[i];
                break;
            }
        }
        if (!imageItem) return; // 画像以外は既定の貼り付け動作に任せる

        e.preventDefault();
        var file = imageItem.getAsFile();
        if (!file) return;

        var pastingResultId = currentResultId;
        var textareaEl = $("#knowledgeBodyInput").get(0);
        var cursorPos = textareaEl ? textareaEl.selectionStart : 0;
        var reader = new FileReader();
        reader.onload = function () {
            var base64 = String(reader.result).split(",")[1];
            var extension = "." + (file.type.split("/")[1] || "png");
            uploadPastedImage(pastingResultId, base64, extension, cursorPos);
        };
        reader.readAsDataURL(file);
    }

    function uploadPastedImage(resultId, base64, extension, cursorPos) {
        $("#knowledgeSaveStatus").text("画像をアップロード中...");
        // このリクエスト時点でのサーバー側Bodyを基準にする（クライアントのUndo後の表示内容と食い違うことがあるため、
        // 常にサーバーの最新状態を追跡している knownServerBody を使う）
        var prevServerBody = knownServerBody;
        $p.apiUpdate({
            id: resultId,
            data: {
                ImageHash: {
                    Body: {
                        HeadNewLine: true,
                        EndNewLine: true,
                        Position: -1,
                        Alt: "image",
                        Extension: extension,
                        Base64: base64
                    }
                }
            },
            done: function () {
                if (currentResultId === resultId) {
                    insertUploadedImageAtCursor(resultId, cursorPos, prevServerBody);
                }
            },
            fail: function (err) {
                $("#knowledgeSaveStatus").text("画像の挿入に失敗しました");
                console.error("画像の挿入に失敗しました", err);
            }
        });
    }

    function commonPrefixLength(a, b) {
        var max = Math.min(a.length, b.length);
        var i = 0;
        while (i < max && a[i] === b[i]) i++;
        return i;
    }

    function insertUploadedImageAtCursor(resultId, cursorPos, prevServerBody) {
        // ImageHash更新はサーバー側で本文の末尾にMarkdownを追記するだけなので、今回の貼り付けで追記された分だけを
        // prevServerBodyとの差分で取り出し、execCommandでカーソル位置に挿入する
        // （textarea.value代入だとブラウザのUndo履歴が消えてしまうため）。
        // サーバー側の本文はここでは直さず、通常の保存(Ctrl+S/保存ボタン)に任せる。
        $p.apiGet({
            id: resultId,
            data: {},
            done: function (data) {
                var rec = data && data.Response && data.Response.Data && data.Response.Data[0];
                if (!rec || currentResultId !== resultId) return;

                var serverBody = ensureMarkdownMarker(rec.Body || "");
                knownServerBody = serverBody; // 次回の貼り付けのためにサーバー側の最新状態を更新しておく
                var prefixLen = commonPrefixLength(prevServerBody, serverBody);
                var appendedSnippet = serverBody.slice(prefixLen);

                var $textarea = $("#knowledgeBodyInput");
                var textareaEl = $textarea.get(0);
                var insertAt = Math.min(cursorPos, textareaEl ? textareaEl.value.length : 0);
                var inserted = false;
                if (textareaEl) {
                    textareaEl.focus();
                    textareaEl.setSelectionRange(insertAt, insertAt);
                    try {
                        inserted = document.execCommand("insertText", false, appendedSnippet);
                    } catch (e) {
                        inserted = false;
                    }
                }
                if (!inserted) {
                    // execCommandが使えない場合のフォールバック（この場合のみUndo履歴が失われる）
                    var current = textareaEl ? textareaEl.value : "";
                    var newBody = current.slice(0, insertAt) + appendedSnippet + current.slice(insertAt);
                    $textarea.val(newBody).trigger("input");
                    if (textareaEl) {
                        var pos = insertAt + appendedSnippet.length;
                        textareaEl.setSelectionRange(pos, pos);
                    }
                }
            },
            fail: function (err) {
                console.error("本文の再取得に失敗しました", err);
            }
        });
    }

    function setBodyMode(mode) {
        bodyViewMode = mode;
        var labelByMode = { edit: "編集中", preview: "プレビュー中", split: "同時表示中" };
        var isWide = mode === "edit" || mode === "split";
        $("#knowledgeEditor").toggleClass("is-wide", isWide);
        $("#knowledgeApp").toggleClass("is-wide-editor", isWide);

        if (mode === "edit") {
            $("#knowledgeBodyArea").removeClass("is-split");
            $("#knowledgeBodyPreview").hide();
            $("#knowledgeBodyInput").show();
            $("#knowledgeTocSection").hide();
            updateBodyModeUI(mode, labelByMode[mode]);
        } else {
            ensureMarkdownLibs(function () {
                renderBodyPreview();
                $("#knowledgeBodyArea").toggleClass("is-split", mode === "split");
                $("#knowledgeBodyInput").toggle(mode === "split");
                $("#knowledgeBodyPreview").show();
                updateBodyModeUI(mode, labelByMode[mode]);
            });
        }
    }

    function updateBodyModeUI(mode, labelText) {
        $("#knowledgeBodyModeSwitch .mode-switch-btn").removeClass("is-active");
        $("#knowledgeBodyModeSwitch .mode-switch-btn[data-mode='" + mode + "']").addClass("is-active");
        $("#knowledgeBodyModeLabel").text(labelText).attr("class", "mode-badge is-" + mode);
    }

    function renderBodyPreview() {
        var source = stripMarkdownMarker($("#knowledgeBodyInput").val() || "");
        var html = window.marked.parse(source);
        // marked.jsはHTMLをそのまま出力するため、DOMPurifyでサニタイズしてからDOMに反映する
        var safeHtml = window.DOMPurify ? window.DOMPurify.sanitize(html) : escapeHtml(html);
        $("#knowledgeBodyPreview").html(safeHtml);
        renderMermaidDiagrams();
        renderCodeHighlighting();
        buildTocFromPreview();
    }

    function renderCodeHighlighting() {
        // mermaidブロックはrenderMermaidDiagramsで図に置き換えられるので、それ以外のコードブロックだけを対象にする
        var $blocks = $("#knowledgeBodyPreview pre code").not(".language-mermaid");
        if ($blocks.length === 0) return;
        ensureHighlightLib(function () {
            $blocks.each(function () {
                window.hljs.highlightElement(this);
            });
        });
    }

    function renderMermaidDiagrams() {
        // ```mermaid ブロックはmarked.jsにより<pre><code class="language-mermaid">として出力されるので、
        // VS Codeと同様に図として描画し直す
        var $blocks = $("#knowledgeBodyPreview pre code.language-mermaid");
        if ($blocks.length === 0) return;
        ensureMermaidLib(function () {
            var $wrappers = $blocks.map(function () {
                var $wrapper = $('<div class="mermaid"></div>').text($(this).text());
                $(this).closest("pre").replaceWith($wrapper);
                return $wrapper.get(0);
            });
            try {
                window.mermaid.run({ nodes: $wrappers.toArray() });
            } catch (e) {
                console.error("Mermaid図の描画に失敗しました", e);
            }
        });
    }

    function buildTocFromPreview() {
        // プレビュー内の見出しから右側の「見出し」セクションを生成する
        var $toc = $("#knowledgeTocList").empty();
        var $headings = $("#knowledgeBodyPreview").find("h1, h2, h3, h4");
        if ($headings.length === 0) {
            $("#knowledgeTocSection").hide();
            return;
        }
        $headings.each(function (index) {
            var $heading = $(this);
            var anchorId = "knowledgeTocHeading" + index;
            $heading.attr("id", anchorId);
            var level = parseInt(this.tagName.substring(1), 10);
            var $item = $(
                '<div class="toc-item toc-level-' + level + '">' + escapeHtml($heading.text()) + '</div>'
            );
            $item.on("click", function () {
                var target = document.getElementById(anchorId);
                if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
            });
            $toc.append($item);
        });
        $("#knowledgeTocSection").show();

        $(window).off("scroll.knowledgeToc").on("scroll.knowledgeToc", updateActiveTocItem);
        $("#knowledgeBodyPreview").off("scroll.knowledgeToc").on("scroll.knowledgeToc", updateActiveTocItem);
        updateActiveTocItem();
    }

    function updateActiveTocItem() {
        var headings = $("#knowledgeBodyPreview").find("h1, h2, h3, h4").toArray();
        if (headings.length === 0) return;
        var activeIndex = 0;
        headings.forEach(function (heading, index) {
            if (heading.getBoundingClientRect().top <= 120) activeIndex = index;
        });
        $("#knowledgeTocList .toc-item").removeClass("is-active");
        $("#knowledgeTocList .toc-item").eq(activeIndex).addClass("is-active");
    }

    function ensureMarkdownLibs(onReady) {
        if (window.marked && window.DOMPurify) {
            onReady();
            return;
        }
        if (!markdownLibsPromise) {
            markdownLibsPromise = $.when($.getScript(MARKED_URL), $.getScript(DOMPURIFY_URL)).done(function () {
                // 単一改行を<br>として扱う（メモ用途では改行がそのまま反映される方が直感的なため）
                window.marked.setOptions({ breaks: true, gfm: true });
            });
        }
        markdownLibsPromise.done(onReady).fail(function () {
            console.error("Markdownライブラリ(marked.js / DOMPurify)の読み込みに失敗しました");
        });
    }

    function ensureMermaidLib(onReady) {
        if (window.mermaid) {
            onReady();
            return;
        }
        if (!mermaidLibPromise) {
            mermaidLibPromise = $.getScript(MERMAID_URL).done(function () {
                window.mermaid.initialize({ startOnLoad: false });
            });
        }
        mermaidLibPromise.done(onReady).fail(function () {
            console.error("Mermaidライブラリの読み込みに失敗しました");
        });
    }

    function ensureHighlightLib(onReady) {
        if (window.hljs) {
            onReady();
            return;
        }
        if (!hljsLibPromise) {
            if (!$("#knowledgeHljsStyle").length) {
                $("<link>", { id: "knowledgeHljsStyle", rel: "stylesheet", href: HLJS_CSS_URL }).appendTo("head");
            }
            hljsLibPromise = $.getScript(HLJS_URL);
        }
        hljsLibPromise.done(onReady).fail(function () {
            console.error("シンタックスハイライトライブラリ(highlight.js)の読み込みに失敗しました");
        });
    }

    function renderTags(selectedTagIds) {
        currentTagIds = selectedTagIds.slice();
        renderTagPills();
    }

    function renderTagPills() {
        var $box = $("#knowledgeTagChecks").empty();
        // 有効なタグ（実在するタグID）のみをピル表示する
        currentTagIds
            .filter(function (tagId) { return !!tagTitleById[tagId]; })
            .forEach(function (tagId) {
                var $pill = $(
                    '<span class="knowledge-tag-pill" data-tag-id="' + tagId + '">' +
                    escapeHtml(tagTitleById[tagId]) +
                    '</span>'
                );
                $pill.on("click", function () {
                    currentTagIds = currentTagIds.filter(function (id) { return id !== String(tagId); });
                    renderTagPills();
                    markDirty();
                });
                $box.append($pill);
            });

        var $addTag = $('<span class="tag-add-item">＋ タグを追加</span>');
        $addTag.on("click", function (e) {
            e.stopPropagation();
            showTagPicker($(this));
        });
        $box.append($addTag);
    }

    function showTagPicker($anchor) {
        closeTagPicker();
        var offset = $anchor.offset();
        var availableTagIds = Object.keys(tagTitleById).filter(function (tagId) {
            return currentTagIds.indexOf(String(tagId)) === -1;
        });

        var $menu = $('<div id="knowledgeTagPicker"></div>');
        if (availableTagIds.length === 0) {
            $menu.append('<div class="context-menu-item is-disabled">追加できるタグがありません</div>');
        } else {
            availableTagIds.forEach(function (tagId) {
                var $option = $(
                    '<div class="context-menu-item">' + escapeHtml(tagTitleById[tagId]) + '</div>'
                );
                $option.on("click", function () {
                    closeTagPicker();
                    currentTagIds.push(String(tagId));
                    renderTagPills();
                    markDirty();
                });
                $menu.append($option);
            });
        }
        $menu.append('<div class="context-menu-separator"></div>');
        var $createNew = $('<div class="context-menu-item">＋ 新しいタグを作成</div>');
        $createNew.on("click", function () {
            closeTagPicker();
            createAndAddTag();
        });
        $menu.append($createNew);

        $menu.css({ left: offset.left + "px", top: (offset.top + $anchor.outerHeight() + 4) + "px" });
        $("body").append($menu);
        setTimeout(function () {
            $(document).on("click.knowledgeTagPicker", closeTagPicker);
        }, 0);
    }

    function closeTagPicker() {
        $("#knowledgeTagPicker").remove();
        $(document).off("click.knowledgeTagPicker");
    }

    function createAndAddTag() {
        var title = window.prompt("新しいタグ名を入力してください");
        if (!title) return;

        $p.apiCreate({
            id: TAG_SITE_ID,
            data: { Title: title },
            done: function (data) {
                tagTitleById[data.Id] = title;
                currentTagIds.push(String(data.Id));
                renderTagPills();
                markDirty();
            },
            fail: function (err) {
                console.error("タグの作成に失敗しました", err);
            }
        });
    }

    function markDirty() {
        isDirty = true;
        $("#knowledgeSaveStatus").text("未保存の変更があります（Ctrl+Sで保存）")
            .removeClass("is-saved").addClass("is-unsaved");
    }

    function renderMetaRow(updatedTime, updator) {
        $("#knowledgeUpdatedTime").text(formatDateTime(updatedTime));
        $("#knowledgeUpdator").text("");
        resolveUserName(updator, function (name) {
            $("#knowledgeUpdator").text(name);
        });
    }

    function formatDateTime(value) {
        if (!value) return "";
        return String(value).replace("T", " ").slice(0, 16);
    }

    function resolveUserName(userId, callback) {
        if (!userId) {
            callback("");
            return;
        }
        if (userNameById[userId]) {
            callback(userNameById[userId]);
            return;
        }
        $p.apiUsersGet({
            id: userId,
            done: function (data) {
                var user = data && data.Response && data.Response.Data && data.Response.Data[0];
                var name = user ? user.Name : String(userId);
                userNameById[userId] = name;
                callback(name);
            },
            fail: function () {
                callback(String(userId));
            }
        });
    }

    function saveCurrentKnowledge() {
        if (!currentResultId) return;
        var savingResultId = currentResultId;
        var title = $("#knowledgeTitleInput").val();
        var body = ensureMarkdownMarker($("#knowledgeBodyInput").val() || "");

        $("#knowledgeSaveStatus").text("保存中...").removeClass("is-unsaved is-saved");
        $p.apiUpdate({
            id: savingResultId,
            data: {
                Title: title,
                Body: body,
                ClassHash: { ClassA: JSON.stringify(currentTagIds) }
            },
            done: function () {
                isDirty = false;
                if (currentResultId === savingResultId) knownServerBody = body; // 保存後はサーバーもこの内容になる
                $("#knowledgeSaveStatus").text("保存しました").removeClass("is-unsaved").addClass("is-saved");
                refreshKnowledgeList(function () {
                    $('.knowledge-item[data-result-id="' + savingResultId + '"]').addClass("is-selected");
                    var item = knowledgeById[savingResultId];
                    if (item && currentResultId === savingResultId) {
                        renderMetaRow(item.UpdatedTime, item.Updator);
                    }
                });
            },
            fail: function (err) {
                $("#knowledgeSaveStatus").text("保存に失敗しました").removeClass("is-saved").addClass("is-unsaved");
                console.error("ナレッジの保存に失敗しました", err);
            }
        });
    }

    function createKnowledge(parentId, order) {
        if (!confirmDiscardIfDirty()) return;
        var data = {
            Title: "新規ページ",
            Body: MARKDOWN_MARKER + "\n",
            NumHash: { NumA: order }
        };
        if (parentId) data.ClassHash = { ClassB: parentId };

        $p.apiCreate({
            id: KNOWLEDGE_SITE_ID,
            data: data,
            done: function (res) {
                if (parentId) expandedIds[parentId] = true;
                refreshKnowledgeList(function () {
                    openKnowledge(res.Id);
                });
            },
            fail: function (err) {
                console.error("ナレッジの作成に失敗しました", err);
            }
        });
    }

    function deleteCurrentKnowledge() {
        if (!currentResultId) return;
        deleteKnowledgeById(currentResultId);
    }

    function deleteKnowledgeById(resultId) {
        if (!window.confirm("このナレッジを削除しますか？（子ページは最上位に移動します）")) return;

        $p.apiDelete({
            id: resultId,
            done: function () {
                if (window.localStorage.getItem(LAST_OPENED_STORAGE_KEY) === String(resultId)) {
                    window.localStorage.removeItem(LAST_OPENED_STORAGE_KEY);
                }
                if (currentResultId === resultId) {
                    currentResultId = null;
                    renderEmptyEditor();
                }
                refreshKnowledgeList();
            },
            fail: function (err) {
                console.error("ナレッジの削除に失敗しました", err);
            }
        });
    }

    function renderEmptyEditor() {
        $(window).off("scroll.knowledgeToc");
        $("#knowledgeEditor").html(
            '<div id="knowledgeEmptyState">左の一覧からナレッジを選択するか、新規作成してください。</div>'
        );
        $("#knowledgeTagChecks").empty();
        $("#knowledgeTocList").empty();
        $("#knowledgeTocSection").hide();
    }

    function parseClassAIds(classA) {
        // 分類項目(選択肢あり)の値はJSON配列文字列（例: ["3","7"]）で保存されている。
        if (!classA) return [];
        try {
            var ids = JSON.parse(classA);
            return Array.isArray(ids) ? ids.map(String) : [];
        } catch (e) {
            return [];
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
})();