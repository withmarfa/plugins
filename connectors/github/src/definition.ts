import {
  defineConnector,
  verifyHmac,
  type SettingsDeclaration,
  type SettingValues,
  type TypeDefinition,
} from "@withmarfa/connector";
import {
  blockedBy,
  childOf,
  relatesTo,
  duplicateOf,
  commentType,
  discussionType,
  githubClosedBy,
  githubCloses,
  inRepository,
  commentsOn,
  inThread,
  issueType,
  pullRequestType,
  about,
  references,
  repositoryType,
  subIssueOf,
} from "./entries.js";
import { carryDiscussions, remakeDiscussions } from "./discussion-write.js";
import { defaultBase, spacingOf, type App } from "./github.js";
import { hints } from "./hooks.js";
import { notificationType } from "./notifications.js";
import { read } from "./read.js";
import { fileKinds, filesConnection } from "./files.js";
import {
  directoryType,
  filesOf,
  inCollection,
  repositoryFileType,
} from "./repository-files.js";
import { scopeOf } from "./scope.js";
import { readOnly, setUp } from "./setup.js";
import { carry, remake } from "./write.js";
import comment from "./github.comment.json" with { type: "json" };
import discussion from "./github.discussion.json" with { type: "json" };
import issue from "./github.issue.json" with { type: "json" };
import pullRequest from "./github.pull_request.json" with { type: "json" };
import notification from "./github.notification.json" with { type: "json" };
import repository from "./github.repository.json" with { type: "json" };
import repositoryFile from "./github.repository_file.json" with { type: "json" };
import directory from "./github.directory.json" with { type: "json" };

const githubSettings = [
  { name: "github_app_id", label: "GitHub App ID", kind: "text" },
  {
    name: "github_private_key",
    label: "GitHub App private key",
    kind: "text",
    secret: true,
  },
  {
    name: "github_webhook_secret",
    label: "Webhook secret",
    kind: "text",
    secret: true,
  },
  {
    name: "github_personal_token",
    label: "Personal access token",
    kind: "text",
    secret: true,
  },
  {
    name: "github_notifications_token",
    label: "Notifications token",
    kind: "text",
    secret: true,
  },
  { name: "github_read_only", label: "Read only", kind: "text" },
  {
    name: "github_stars",
    label: "Read your stars",
    kind: "boolean",
    default: true,
  },
  {
    name: "github_api_url",
    label: "GitHub API address",
    kind: "text",
    default: defaultBase,
  },
  {
    name: "github_request_spacing_ms",
    label: "Spacing between requests in milliseconds",
    kind: "number",
  },
  { name: "github_public_url", label: "Public address of Marfa", kind: "text" },
  { name: "github_organization", label: "Organization", kind: "text" },
  { name: "github_app_name", label: "GitHub App name", kind: "text" },
  { name: "github_repositories", label: "Repositories", kind: "text" },
  { name: "github_files", label: "Files", kind: "text" },
] as const satisfies SettingsDeclaration;

function appOf(values: {
  github_app_id: string | undefined;
  github_private_key: string | undefined;
  github_api_url: string;
  github_request_spacing_ms: number | undefined;
}): App {
  if (
    values.github_app_id === undefined ||
    values.github_private_key === undefined
  )
    throw new Error(
      "GitHub writes require github_app_id and github_private_key",
    );
  return {
    appId: values.github_app_id,
    privateKey: values.github_private_key,
    base: values.github_api_url,
    spacingMs: spacingOf(values),
  };
}

type Settings = Readonly<Partial<SettingValues<typeof githubSettings>>>;

/** The connector for the settings a run reads, which the kit builds again at
 *  the start of each run. With none, it is in its widest shape. */
export function connector(settings: Settings = {}) {
  // A process that reads no stars holds no star field, so it never writes or
  // puts back the marks another process sets on the rows it syncs.
  const starFields =
    settings.github_stars === false ? [] : ["starred", "starred_at"];
  return defineConnector<typeof githubSettings>({
    name: "github",
    title: "GitHub",
    mark: "simple-icons:github",
    maker: "WithMarfa",
    description:
      "Repositories, issues, discussions, comments, pull requests, notifications and Markdown files from chosen repository paths, with relations and checks. A personal token reads only; a GitHub App can carry issue, discussion and comment edits back.",
    source: "github",
    sourceName: "GitHub",
    sourceMark: "simple-icons:github",
    types: [
      ...fileKinds,
      {
        // Imported JSON widens every string; the check on start holds the
        // file to the server's.
        name: "repository",
        direction: "in",
        type: repository as TypeDefinition,
        fields: [
          "github_id",
          "name",
          "url",
          "description",
          "private",
          "archived_on_github",
          ...starFields,
          "synced",
        ],
        readOnly: [...starFields, "synced"],
        derived: [...starFields, "synced"],
        // Nothing turns a synced row into a star-only one: a star-only write,
        // or one process putting back what it last wrote, leaves `synced`
        // alone, and a row another process has marked synced since this one
        // agreed on it is not this one's to archive.
        policy: (item, entry, archiving) =>
          item?.properties["synced"] !== true
            ? {}
            : archiving !== undefined && !archiving.agrees("synced")
              ? { owned: false }
              : entry?.properties["synced"] !== true
                ? { fields: { synced: "observe" } }
                : {},
      },
      {
        name: "issue",
        direction: "both",
        type: issue as TypeDefinition,
        fields: [
          "github_id",
          "title",
          "body",
          "status",
          "completed_at",
          "url",
          "number",
          "repository",
          "private",
          "author",
          "labels",
          "assignees",
          "state_reason",
          "github_updated_at",
          "github_files",
          "parent_url",
          "blocked_by_urls",
          "related_urls",
          "duplicate_of_url",
          "closed_by_url",
        ],
        readOnly: [
          "completed_at",
          "url",
          "number",
          "repository",
          "private",
          "author",
          "state_reason",
          "github_updated_at",
          "github_files",
          "parent_url",
          "blocked_by_urls",
          "related_urls",
          "duplicate_of_url",
          inRepository,
          duplicateOf,
          "closed_by_url",
          githubClosedBy,
        ],
        derived: ["private", "github_files"],
        revive: true,
      },
      {
        name: "comment",
        direction: "both",
        type: comment as TypeDefinition,
        fields: [
          "github_id",
          "body",
          "from",
          "repository",
          "private",
          "url",
          "github_files",
        ],
        readOnly: [
          "github_files",
          "from",
          "repository",
          "private",
          "url",
          commentsOn,
          inRepository,
        ],
        derived: ["private", "github_files"],
      },
      {
        name: "discussion",
        direction: "both",
        type: discussion as TypeDefinition,
        fields: [
          "github_id",
          "title",
          "body",
          "number",
          "repository",
          "private",
          "author",
          "category",
          "status",
          "state_reason",
          "answered",
          "locked",
          "url",
          "github_updated_at",
        ],
        readOnly: [
          "number",
          "repository",
          "private",
          "author",
          "category",
          "answered",
          "locked",
          "url",
          "github_updated_at",
          inRepository,
        ],
        derived: ["private"],
      },
      {
        name: "pull_request",
        direction: "in",
        type: pullRequest as TypeDefinition,
        fields: [
          "github_id",
          "title",
          "body",
          "status",
          "completed_at",
          "url",
          "number",
          "repository",
          "private",
          "author",
          "merged_at",
          "base_branch",
          "head_branch",
          "checks",
          "github_updated_at",
        ],
        readOnly: [
          "title",
          "body",
          "status",
          "completed_at",
          "url",
          "number",
          "repository",
          "private",
          "author",
          "merged_at",
          "base_branch",
          "head_branch",
          "checks",
          "github_updated_at",
          inRepository,
          githubCloses,
        ],
        derived: ["private"],
        retired: ["pr_state", "draft"],
      },
      {
        name: "notification",
        direction: "in",
        type: notification as TypeDefinition,
        fields: [
          "body",
          "from",
          "github_id",
          "reason",
          "unread",
          "github_updated_at",
          "last_read_at",
          "subject_type",
          "url",
          "private",
        ],
        readOnly: [
          "body",
          "from",
          "github_id",
          "reason",
          "unread",
          "github_updated_at",
          "last_read_at",
          "subject_type",
          "url",
          "private",
          about,
        ],
      },
      // GitHub is the source of these, whatever github_read_only says: no
      // kind outside `carries` goes back, so the kit puts back every edit.
      {
        name: "repository_file",
        direction: "in",
        type: repositoryFile as TypeDefinition,
        fields: [
          "title",
          "body",
          "repository",
          "path",
          "blob_sha",
          "url",
          "private",
        ],
        readOnly: [
          "title",
          "body",
          "repository",
          "path",
          "blob_sha",
          "url",
          "private",
          inCollection,
          inRepository,
        ],
        derived: ["private"],
      },
      {
        name: "directory",
        direction: "in",
        type: directory as TypeDefinition,
        fields: ["title", "repository", "path", "url", "private"],
        readOnly: [
          "title",
          "repository",
          "path",
          "url",
          "private",
          childOf,
          inRepository,
        ],
        derived: ["private"],
      },
    ],
    retired: [
      { type: notificationType, connection: references },
      { type: commentType, connection: inThread },
      { type: commentType, connection: childOf },
    ],
    connections: [
      filesConnection,
      {
        id: about,
        label: "About",
        description:
          "A GitHub notification and the synced issue, pull request or discussion it concerns.",
        cardinality: "many-to-many",
        from_type_constraints: [notificationType],
        to_type_constraints: [issueType, pullRequestType, discussionType],
      },
      {
        id: inRepository,
        label: "In repository",
        description:
          "An issue, discussion, comment, pull request, repository file or directory in the GitHub repository it belongs to.",
        cardinality: "many-to-one",
        from_type_constraints: [
          issueType,
          commentType,
          discussionType,
          pullRequestType,
          repositoryFileType,
          directoryType,
        ],
        to_type_constraints: [repositoryType],
      },
      {
        id: subIssueOf,
        label: "Sub-issue of",
        description: "A GitHub issue beneath its parent issue.",
        cardinality: "many-to-one",
        from_type_constraints: [issueType],
        to_type_constraints: [issueType],
      },
      {
        id: blockedBy,
        label: "Blocked by",
        description: "A GitHub issue blocked by another.",
        cardinality: "many-to-many",
        from_type_constraints: [issueType],
        to_type_constraints: [issueType],
      },
      {
        id: relatesTo,
        label: "Relates to",
        description: "Two related GitHub issues, ordered by node ID.",
        cardinality: "many-to-many",
        from_type_constraints: [issueType],
        to_type_constraints: [issueType],
      },
      {
        id: duplicateOf,
        label: "Duplicate of",
        description: "A duplicate GitHub issue and its canonical issue.",
        cardinality: "many-to-one",
        from_type_constraints: [issueType],
        to_type_constraints: [issueType],
      },
      // Retired (see `retired`): cleared on every row written with them, so one synced before
      // holds only `about` and `comments-on`.
      {
        id: references,
        cardinality: "many-to-many",
        from_type_constraints: [notificationType],
        to_type_constraints: [issueType, pullRequestType, discussionType],
      },
      {
        id: inThread,
        cardinality: "many-to-one",
        from_type_constraints: [commentType],
        to_type_constraints: [issueType, discussionType],
      },
      {
        id: commentsOn,
        cardinality: "many-to-one",
        cascade_on_delete: "with-hosts",
        from_type_constraints: [commentType],
        to_type_constraints: [issueType, discussionType, commentType],
      },
      {
        id: childOf,
        cardinality: "many-to-one",
        cascade_on_delete: "cascade",
        from_type_constraints: [commentType, directoryType],
        to_type_constraints: [commentType, directoryType],
      },
      {
        id: inCollection,
        cardinality: "many-to-many",
        from_type_constraints: [repositoryFileType],
        to_type_constraints: [directoryType],
      },
      {
        id: githubCloses,
        label: "Closes",
        description:
          "A GitHub pull request and an issue it closes, from the pull request's closing issues references.",
        cardinality: "many-to-many",
        from_type_constraints: [pullRequestType],
        to_type_constraints: [issueType],
      },
      {
        id: githubClosedBy,
        label: "Closed by",
        description:
          "A GitHub issue and the synced pull request that closed it.",
        cardinality: "many-to-one",
        from_type_constraints: [issueType],
        to_type_constraints: [pullRequestType],
      },
    ],
    settings: githubSettings,
    carries: (values) =>
      values.github_personal_token !== undefined
        ? []
        : [issueType, commentType, discussionType].filter(
            (kind) =>
              !readOnly(values.github_read_only, kind.slice("github.".length)),
          ),
    checkEnv(values) {
      scopeOf(values.github_repositories);
      filesOf(values.github_files);
      readOnly(values.github_read_only);
      spacingOf(values);
      const app = [
        values.github_app_id,
        values.github_private_key,
        values.github_webhook_secret,
      ];
      if (values.github_personal_token !== undefined) {
        if (app.some((one) => one !== undefined))
          throw new Error(
            "choose either github_personal_token or the GitHub App settings",
          );
      } else if (app.some((one) => one === undefined)) {
        throw new Error(
          "set github_personal_token or all of github_app_id, github_private_key and github_webhook_secret",
        );
      }
    },
    setup(context) {
      return setUp(context, context.env);
    },
    run(context) {
      return read(
        context,
        context.env.github_personal_token === undefined
          ? appOf(context.env)
          : {
              token: context.env.github_personal_token,
              base: context.env.github_api_url,
              spacingMs: spacingOf(context.env),
            },
        scopeOf(context.env.github_repositories),
        {
          token: context.env.github_notifications_token,
          scopeText: context.env.github_repositories,
        },
        context.env.github_stars,
        filesOf(context.env.github_files),
      );
    },
    async onChange(change, context) {
      const app = appOf(context.env);
      const handled = await carryDiscussions(change, context, app);
      return handled === undefined
        ? carry(change, context, app)
        : handled.entry;
    },
    async remake(change, context) {
      const app = appOf(context.env);
      return (
        (await remakeDiscussions(change, context, app)) ??
        remake(change, context, app)
      );
    },
    ...(settings.github_personal_token !== undefined
      ? {}
      : {
          inbound: {
            verify: (delivery, values) =>
              verifyHmac({
                secret: values.github_webhook_secret ?? "",
                body: delivery.body,
                signature: delivery.header("x-hub-signature-256"),
                prefix: "sha256=",
              }),
            hints,
          },
        }),
  });
}
