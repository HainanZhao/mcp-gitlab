import fetch from "node-fetch";
import {
  GitLabConfig,
  GitLabMRDetails,
  GitLabProject,
  GitLabMergeRequest,
  GitLabPosition,
  ParsedHunk,
} from "./gitlab.js";

export class GitLabService {
  private readonly config: GitLabConfig;
  private projectCache: { data: GitLabProject[]; timestamp: number } | null = null;
  private readonly CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(config: GitLabConfig) {
    this.config = config;
  }

  private async callGitLabApi<T>(
    endpoint: string,
    method: string = "GET",
    body?: object
  ): Promise<T> {
    const url = `${this.config.url}/api/v4/${endpoint}`;
    const headers = {
      "Private-Token": this.config.accessToken,
      "Content-Type": "application/json",
    };

    const options: any = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };

    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`GitLab API Error: ${response.status} - ${errorText}`);
        throw new Error(`GitLab API Error: ${response.status} - ${errorText}`);
      }
      return response.json() as Promise<T>;
    } catch (error) {
      console.error(`Failed to call GitLab API: ${error}`);
      throw error;
    }
  }

  private parseDiff(diff: string): ParsedHunk[] {
    const hunks: ParsedHunk[] = [];
    const lines = diff.split("\n");
    let currentHunk: ParsedHunk | null = null;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        // Hunk header
        const headerMatch = line.match(
          /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/
        );
        if (headerMatch) {
          if (currentHunk) {
            hunks.push(currentHunk);
          }
          currentHunk = {
            header: line,
            oldStartLine: parseInt(headerMatch[1], 10),
            oldLineCount: parseInt(headerMatch[2] || "1", 10),
            newStartLine: parseInt(headerMatch[3], 10),
            newLineCount: parseInt(headerMatch[4] || "1", 10),
            lines: [],
            isCollapsed: false,
          };
        }
      } else if (currentHunk) {
        // Hunk content
        let lineType: "add" | "remove" | "context";
        let oldLine: number | undefined;
        let newLine: number | undefined;

        if (line.startsWith("+")) {
          lineType = "add";
          newLine =
            currentHunk.newStartLine +
            currentHunk.lines.filter((l) => l.type !== "remove").length;
        } else if (line.startsWith("-")) {
          lineType = "remove";
          oldLine =
            currentHunk.oldStartLine +
            currentHunk.lines.filter((l) => l.type !== "add").length;
        } else {
          lineType = "context";
          oldLine =
            currentHunk.oldStartLine +
            currentHunk.lines.filter((l) => l.type !== "add").length;
          newLine =
            currentHunk.newStartLine +
            currentHunk.lines.filter((l) => l.type !== "remove").length;
        }

        currentHunk.lines.push({
          type: lineType,
          oldLine,
          newLine,
          content: line,
        });
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }
    return hunks;
  }

  // Utility method to parse GitLab MR URLs
  private parseMrUrl(mrUrl: string, gitlabBaseUrl: string): { projectPath: string; mrIid: number } {
    try {
      const url = new URL(mrUrl);
      const baseUrl = new URL(gitlabBaseUrl);
      
      // Ensure the URL is from the same GitLab instance
      if (url.origin !== baseUrl.origin) {
        throw new Error(`MR URL is not from the configured GitLab instance: ${gitlabBaseUrl}`);
      }
      
      // Parse the path: /{namespace}/{project}/-/merge_requests/{iid}
      const pathMatch = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)/);
      if (!pathMatch) {
        throw new Error(`Invalid GitLab MR URL format: ${mrUrl}`);
      }
      
      const projectPath = pathMatch[1];
      const mrIid = parseInt(pathMatch[2], 10);
      
      return { projectPath, mrIid };
    } catch (error) {
      throw new Error(`Failed to parse GitLab MR URL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Phase 2: Basic Features Implementation will go here
  // 1. Fetch Merge Request Details
  async getMergeRequestDetails(
    projectPath: string,
    mrIid: number
  ): Promise<GitLabMRDetails> {
    const encodedProjectPath = encodeURIComponent(projectPath);
    const baseUrl = `projects/${encodedProjectPath}/merge_requests/${mrIid}`;

    const mrDetails = await this.callGitLabApi<any>(baseUrl);
    const mrChanges = await this.callGitLabApi<any>(`projects/${encodedProjectPath}/merge_requests/${mrIid}/changes`);

    // Map file diffs
    const fileDiffs = mrChanges.changes.map((change: any) => ({
      old_path: change.old_path,
      new_path: change.new_path,
      new_file: change.new_file,
      deleted_file: change.deleted_file,
      renamed_file: change.renamed_file,
      diff: change.diff,
    }));

    const parsedDiffs = fileDiffs.map((diff: any) => ({
      filePath: diff.new_path,
      oldPath: diff.old_path,
      isNew: diff.new_file,
      isDeleted: diff.deleted_file,
      isRenamed: diff.renamed_file,
      hunks: this.parseDiff(diff.diff),
    }));

    return {
      projectPath: mrDetails.path_with_namespace,
      mrIid: mrDetails.iid.toString(),
      projectId: mrDetails.project_id,
      title: mrDetails.title,
      authorName: mrDetails.author.name,
      webUrl: mrDetails.web_url,
      sourceBranch: mrDetails.source_branch,
      targetBranch: mrDetails.target_branch,
      base_sha: mrDetails.diff_refs.base_sha,
      start_sha: mrDetails.diff_refs.start_sha,
      head_sha: mrDetails.diff_refs.head_sha,
      fileDiffs: fileDiffs,
      diffForPrompt: fileDiffs.map((diff: any) => diff.diff).join("\n"),
      parsedDiffs: parsedDiffs,
      fileContents: new Map(), // fileContents will be populated by a separate tool
      discussions: [], // Discussions will be fetched by a separate tool
      existingFeedback: [], // Existing feedback will be derived from discussions
    };
  }

  // Convenience method to get MR details from URL
  async getMergeRequestDetailsFromUrl(mrUrl: string): Promise<GitLabMRDetails> {
    const { projectPath, mrIid } = this.parseMrUrl(mrUrl, this.config.url);
    return this.getMergeRequestDetails(projectPath, mrIid);
  }

  // New tool: Get Merge Request Discussions
  async getMergeRequestDiscussions(
    projectPath: string,
    mrIid: number
  ): Promise<any[]> {
    const encodedProjectPath = encodeURIComponent(projectPath);
    const mrDiscussions = await this.callGitLabApi<any>(`projects/${encodedProjectPath}/merge_requests/${mrIid}/discussions`);

    // Map discussions
    const discussions = mrDiscussions.map((discussion: any) => ({
      id: discussion.id,
      notes: discussion.notes.map((note: any) => ({
        id: note.id,
        body: note.body,
        author: {
          name: note.author.name,
          username: note.author.username,
        },
        system: note.system,
        position: note.position
          ?
            {
              base_sha: note.position.base_sha,
              start_sha: note.position.start_sha,
              head_sha: note.position.head_sha,
              position_type: note.position.position_type,
              old_path: note.position.old_path,
              new_path: note.position.new_path,
              new_line: note.position.new_line,
              old_line: note.position.old_line,
            }
          : undefined,
      })),
      postedAsInline: discussion.individual_note, // Assuming individual_note means inline
    }));
    return discussions;
  }

  // Convenience method to get MR discussions from URL
  async getMergeRequestDiscussionsFromUrl(mrUrl: string): Promise<any[]> {
    const { projectPath, mrIid } = this.parseMrUrl(mrUrl, this.config.url);
    return this.getMergeRequestDiscussions(projectPath, mrIid);
  }

  // New tool: Get File Content
  async getFileContent(
    projectPath: string,
    filePath: string,
    sha: string
  ): Promise<string> {
    const encodedProjectPath = encodeURIComponent(projectPath);
    const encodedFilePath = encodeURIComponent(filePath);
    const content = await this.callGitLabApi<any>(
      `projects/${encodedProjectPath}/repository/files/${encodedFilePath}/raw?ref=${sha}`
    );
    return content;
  }

  // Convenience method to get file content from MR URL and file path/SHA
  async getFileContentFromMrUrl(
    mrUrl: string,
    filePath: string,
    sha: string
  ): Promise<string> {
    const { projectPath } = this.parseMrUrl(mrUrl, this.config.url);
    return this.getFileContent(projectPath, filePath, sha);
  }

  // 2. Add Comment to Merge Request
  async addCommentToMergeRequest(
    projectPath: string,
    mrIid: number,
    discussionId: string | undefined,
    commentBody: string,
    position: GitLabPosition | undefined
  ): Promise<any> {
    const encodedProjectPath = encodeURIComponent(projectPath);

    if (discussionId) {
      // Reply to an existing discussion
      return this.callGitLabApi(
        `projects/${encodedProjectPath}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
        "POST",
        { body: commentBody }
      );
    } else if (position) {
      // Add a new comment with a position (inline comment)
      return this.callGitLabApi(
        `projects/${encodedProjectPath}/merge_requests/${mrIid}/notes`,
        "POST",
        {
          body: commentBody,
          noteable_type: "MergeRequest",
          noteable_id: mrIid,
          position: {
            base_sha: position.base_sha,
            start_sha: position.start_sha,
            head_sha: position.head_sha,
            position_type: position.position_type,
            old_path: position.old_path,
            new_path: position.new_path,
            new_line: position.new_line,
            old_line: position.old_line,
          },
        }
      );
    } else {
      // Add a general comment
      return this.callGitLabApi(
        `projects/${encodedProjectPath}/merge_requests/${mrIid}/notes`,
        "POST",
        { body: commentBody }
      );
    }
  }

  // Convenience method to add comment from MR URL
  async addCommentToMergeRequestFromUrl(
    mrUrl: string,
    commentBody: string,
    discussionId?: string,
    position?: GitLabPosition
  ): Promise<any> {
    const { projectPath, mrIid } = this.parseMrUrl(mrUrl, this.config.url);
    return this.addCommentToMergeRequest(projectPath, mrIid, discussionId, commentBody, position);
  }

  // 3. List Projects
  async listProjects(): Promise<GitLabProject[]> {
    if (this.projectCache && Date.now() - this.projectCache.timestamp < this.CACHE_DURATION_MS) {
      return this.projectCache.data;
    }

    const url = `projects?membership=true&min_access_level=30&order_by=last_activity_at&sort=desc&per_page=100`;
    const projects = await this.callGitLabApi<any[]>(url);

    const simplifiedProjects: GitLabProject[] = projects.map(project => ({
      id: project.id,
      name: project.name,
      name_with_namespace: project.name_with_namespace,
      path_with_namespace: project.path_with_namespace,
      last_activity_at: project.last_activity_at,
      ssh_url_to_repo: project.ssh_url_to_repo,
      http_url_to_repo: project.http_url_to_repo,
      web_url: project.web_url,
      readme_url: project.readme_url,
      issue_branch_template: project.issue_branch_template,
      statistics: project.statistics,
      _links: project._links,
    }));

    this.projectCache = { data: simplifiedProjects, timestamp: Date.now() };
    return simplifiedProjects;
  }

  // 4. List Merge Requests for a Project
  async listMergeRequests(projectPath: string): Promise<GitLabMergeRequest[]> {
    const encodedProjectPath = encodeURIComponent(projectPath);
    return this.callGitLabApi<GitLabMergeRequest[]>(
      `projects/${encodedProjectPath}/merge_requests`
    );
  }

  // New tool: Assign Reviewers to Merge Request
  async assignReviewersToMergeRequest(
    projectPath: string,
    mrIid: number,
    reviewerIds: number[]
  ): Promise<any> {
    const encodedProjectPath = encodeURIComponent(projectPath);
    return this.callGitLabApi(
      `projects/${encodedProjectPath}/merge_requests/${mrIid}`,
      "PUT",
      { reviewer_ids: reviewerIds }
    );
  }

  // Convenience method to assign reviewers from MR URL
  async assignReviewersToMergeRequestFromUrl(
    mrUrl: string,
    reviewerIds: number[]
  ): Promise<any> {
    const { projectPath, mrIid } = this.parseMrUrl(mrUrl, this.config.url);
    return this.assignReviewersToMergeRequest(projectPath, mrIid, reviewerIds);
  }

  // New tool: List Project Members (Contributors)
  async listProjectMembers(projectPath: string): Promise<any[]> {
    const encodedProjectPath = encodeURIComponent(projectPath);
    return this.callGitLabApi<any[]>(`projects/${encodedProjectPath}/members/all`);
  }

  // Convenience method to list project members from MR URL
  async listProjectMembersFromMrUrl(mrUrl: string): Promise<any[]> {
    const { projectPath } = this.parseMrUrl(mrUrl, this.config.url);
    return this.listProjectMembers(projectPath);
  }

  // New tool: List Project Members by Project Name
  async listProjectMembersByProjectName(projectName: string): Promise<any[]> {
    const projects = await this.listProjects();
    const project = projects.find(p => p.name === projectName);
    if (!project) {
      throw new Error(`Project with name ${projectName} not found.`);
    }
    return this.listProjectMembers(project.path_with_namespace);
  }

  // New tool: Filter Projects by Name (fuzzy, case-insensitive)
  async filterProjectsByName(projectName: string): Promise<GitLabProject[]> {
    const allProjects = await this.listProjects();
    const lowerCaseProjectName = projectName.toLowerCase();

    return allProjects.filter(project =>
      project.name.toLowerCase().includes(lowerCaseProjectName) ||
      project.name_with_namespace.toLowerCase().includes(lowerCaseProjectName)
    );
  }

  // New tool: Get Releases for a Project
  async getReleases(projectPath: string): Promise<any[]> {
    const encodedProjectPath = encodeURIComponent(projectPath);
    return this.callGitLabApi<any[]>(`projects/${encodedProjectPath}/releases`);
  }

  // New tool: Filter Releases Since a Specific Version
  async filterReleasesSinceVersion(projectPath: string, sinceVersion: string): Promise<any[]> {
    const allReleases = await this.getReleases(projectPath);
    const semver = await import('semver');

    return allReleases.filter(release => {
      try {
        return semver.gte(release.tag_name, sinceVersion);
      } catch (error) {
        console.warn(`Could not parse version ${release.tag_name} or ${sinceVersion}: ${error}`);
        return false;
      }
    });
  }

  // New tool: Get User ID by Username
  async getUserIdByUsername(username: string): Promise<number> {
    const users = await this.callGitLabApi<any[]>(`users?username=${username}`);
    if (users.length === 0) {
      throw new Error(`User with username ${username} not found.`);
    }
    return users[0].id;
  }

  // New tool: Get User Activities
  async getUserActivities(userId: number, sinceDate?: Date): Promise<any[]> {
    let endpoint = `users/${userId}/events`;
    if (sinceDate) {
      // GitLab API expects ISO 8601 format for `after` parameter
      endpoint += `?after=${sinceDate.toISOString().split('T')[0]}`;
    }
    return this.callGitLabApi<any[]>(endpoint);
  }
}
