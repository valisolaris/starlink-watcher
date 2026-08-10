## タスク種別ルーティング
- ALWAYS: 成果物の作成・変更を伴う依頼(アプリ、機能、スクリプト、テスト、設定ファイル、既存コードの修正など)を受けたら、コードを書き始める前に **work-kickoff Skill**(`.claude/skills/work-kickoff/SKILL.md`)を読み、その手順に従う。例外はない。
- 調査・質問への回答・壁打ち・コードの説明だけの依頼には work-kickoff を使わず、直接回答する。
- どちらか判定に迷ったら「このタスクはファイルを作成・変更するか?」で判定する。Yes なら work-kickoff。

## プロジェクト進行ルーティング(stage-gate)
- 複数の機能・複数Sprintにまたがる開発(新規アプリ、機能群の追加)を始める・
  再開する依頼を受けたら、個別の実装に入る前に **stage-gate Skill**
  (`~/.claude/skills/stage-gate/SKILL.md`)を読み、Stage判定(Stage 0)から始める。
- 単発の小さな修正・単機能の変更は stage-gate を使わず、従来どおり work-kickoff に直行する。
  判定に迷ったら「この依頼は docs/flow/sprints.md 上の複数Sprintにまたがるか?」で判定する。
- stage-gate 進行中の各Sprint実装は work-kickoff の6フェーズに従う
  (stage-gate は work-kickoff を置き換えない。優先順位: stage-gate が外側、work-kickoff が内側)。
- work-kickoff が未導入(`.claude/skills/work-kickoff/SKILL.md` が無い)場合、
  実装に入る前にユーザーへ `/wk-install` の実行を案内する(代行はしない)。
