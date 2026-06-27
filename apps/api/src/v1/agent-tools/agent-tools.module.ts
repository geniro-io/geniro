import { forwardRef, Module } from '@nestjs/common';

import { AgentMemoryModule } from '../agent-memory/agent-memory.module';
import { GitRepositoriesModule } from '../git-repositories/git-repositories.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LitellmModule } from '../litellm/litellm.module';
import { OpenaiModule } from '../openai/openai.module';
import { QdrantModule } from '../qdrant/qdrant.module';
import { SubagentsModule } from '../subagents/subagents.module';
import { ThreadStoreModule } from '../thread-store/thread-store.module';
import { AgentMemoryToolGroup } from './tools/common/agent-memory/agent-memory-tool-group';
import { MemoryAppendTool } from './tools/common/agent-memory/memory-append.tool';
import { MemoryDeleteTool } from './tools/common/agent-memory/memory-delete.tool';
import { MemoryGetTool } from './tools/common/agent-memory/memory-get.tool';
import { MemoryListTool } from './tools/common/agent-memory/memory-list.tool';
import { MemorySaveTool } from './tools/common/agent-memory/memory-save.tool';
import { MemorySearchTool } from './tools/common/agent-memory/memory-search.tool';
import { CommunicationExecTool } from './tools/common/communication/communication-exec.tool';
import { CommunicationToolGroup } from './tools/common/communication/communication-tool-group';
import { FilesApplyChangesTool } from './tools/common/files/files-apply-changes.tool';
import { FilesCodebaseSearchTool } from './tools/common/files/files-codebase-search.tool';
import { FilesDeleteTool } from './tools/common/files/files-delete.tool';
import { FilesDirectoryTreeTool } from './tools/common/files/files-directory-tree.tool';
import { FilesFindPathsTool } from './tools/common/files/files-find-paths.tool';
import { FilesReadTool } from './tools/common/files/files-read.tool';
import { FilesSearchTextTool } from './tools/common/files/files-search-text.tool';
import { FilesToolGroup } from './tools/common/files/files-tool-group';
import { FilesWriteFileTool } from './tools/common/files/files-write-file.tool';
import { GhBranchTool } from './tools/common/github/gh-branch.tool';
import { GhCloneTool } from './tools/common/github/gh-clone.tool';
import { GhCommitTool } from './tools/common/github/gh-commit.tool';
import { GhCreatePullRequestTool } from './tools/common/github/gh-create-pull-request.tool';
import { GhIssueCommentTool } from './tools/common/github/gh-issue-comment.tool';
import { GhIssueManageTool } from './tools/common/github/gh-issue-manage.tool';
import { GhPrCommentTool } from './tools/common/github/gh-pr-comment.tool';
import { GhPrReadTool } from './tools/common/github/gh-pr-read.tool';
import { GhPushTool } from './tools/common/github/gh-push.tool';
import { GhToolGroup } from './tools/common/github/gh-tool-group';
import { KnowledgeGetChunksTool } from './tools/common/knowledge/knowledge-get-chunks.tool';
import { KnowledgeGetDocTool } from './tools/common/knowledge/knowledge-get-doc.tool';
import { KnowledgeSearchChunksTool } from './tools/common/knowledge/knowledge-search-chunks.tool';
import { KnowledgeSearchDocsTool } from './tools/common/knowledge/knowledge-search-docs.tool';
import { KnowledgeToolGroup } from './tools/common/knowledge/knowledge-tool-group';
import { ShellTool } from './tools/common/shell.tool';
import { SubagentsListTool } from './tools/common/subagents/subagents-list.tool';
import { SubagentsRunTaskTool } from './tools/common/subagents/subagents-run-task.tool';
import { SubagentsToolGroup } from './tools/common/subagents/subagents-tool-group';
import { ThreadStoreAppendTool } from './tools/common/thread-store/thread-store-append.tool';
import { ThreadStoreDeleteTool } from './tools/common/thread-store/thread-store-delete.tool';
import { ThreadStoreGetTool } from './tools/common/thread-store/thread-store-get.tool';
import { ThreadStoreListTool } from './tools/common/thread-store/thread-store-list.tool';
import { ThreadStorePutTool } from './tools/common/thread-store/thread-store-put.tool';
import { ThreadStoreToolGroup } from './tools/common/thread-store/thread-store-tool-group';
import { ToolSearchTool } from './tools/common/tool-search.tool';
import { WebSearchTool } from './tools/common/web-search.tool';
import { FinishTool } from './tools/core/finish.tool';
import { WaitForTool } from './tools/core/wait-for.tool';

@Module({
  imports: [
    GitRepositoriesModule,
    LitellmModule,
    OpenaiModule,
    KnowledgeModule,
    QdrantModule,
    SubagentsModule,
    AgentMemoryModule,
    forwardRef(() => ThreadStoreModule),
  ],
  controllers: [],
  providers: [
    ShellTool,
    WebSearchTool,
    FinishTool,
    WaitForTool,
    ToolSearchTool,
    CommunicationExecTool,
    CommunicationToolGroup,
    GhCloneTool,
    GhCommitTool,
    GhBranchTool,
    GhPushTool,
    GhCreatePullRequestTool,
    GhIssueManageTool,
    GhIssueCommentTool,
    GhPrReadTool,
    GhPrCommentTool,
    GhToolGroup,
    KnowledgeSearchDocsTool,
    KnowledgeSearchChunksTool,
    KnowledgeGetChunksTool,
    KnowledgeGetDocTool,
    KnowledgeToolGroup,
    FilesFindPathsTool,
    FilesDirectoryTreeTool,
    FilesReadTool,
    FilesSearchTextTool,
    FilesCodebaseSearchTool,
    FilesWriteFileTool,
    FilesApplyChangesTool,
    FilesDeleteTool,
    FilesToolGroup,
    SubagentsListTool,
    SubagentsRunTaskTool,
    SubagentsToolGroup,
    ThreadStorePutTool,
    ThreadStoreAppendTool,
    ThreadStoreGetTool,
    ThreadStoreListTool,
    ThreadStoreDeleteTool,
    ThreadStoreToolGroup,
    MemorySaveTool,
    MemoryAppendTool,
    MemoryGetTool,
    MemoryListTool,
    MemoryDeleteTool,
    MemorySearchTool,
    AgentMemoryToolGroup,
  ],
  exports: [
    ShellTool,
    WebSearchTool,
    FinishTool,
    WaitForTool,
    ToolSearchTool,
    CommunicationExecTool,
    CommunicationToolGroup,
    GhCloneTool,
    GhCommitTool,
    GhBranchTool,
    GhPushTool,
    GhCreatePullRequestTool,
    GhIssueManageTool,
    GhIssueCommentTool,
    GhPrReadTool,
    GhPrCommentTool,
    GhToolGroup,
    KnowledgeSearchDocsTool,
    KnowledgeSearchChunksTool,
    KnowledgeGetChunksTool,
    KnowledgeGetDocTool,
    KnowledgeToolGroup,
    FilesFindPathsTool,
    FilesDirectoryTreeTool,
    FilesReadTool,
    FilesSearchTextTool,
    FilesCodebaseSearchTool,
    FilesWriteFileTool,
    FilesApplyChangesTool,
    FilesDeleteTool,
    FilesToolGroup,
    SubagentsListTool,
    SubagentsRunTaskTool,
    SubagentsToolGroup,
    ThreadStorePutTool,
    ThreadStoreAppendTool,
    ThreadStoreGetTool,
    ThreadStoreListTool,
    ThreadStoreDeleteTool,
    ThreadStoreToolGroup,
    MemorySaveTool,
    MemoryAppendTool,
    MemoryGetTool,
    MemoryListTool,
    MemoryDeleteTool,
    MemorySearchTool,
    AgentMemoryToolGroup,
  ],
})
export class AgentToolsModule {}
