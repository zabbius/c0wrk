import { useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { FileTreePanel } from "./FileTreePanel";
import { VectorStorePanel } from "./VectorStorePanel";
import { GitPanel } from "@/components/GitPanel";
import { ResearchPanel } from "@/components/research";
import { useProjectStore, selectIsNoProject } from "@/stores/projectStore";
import { useGitPanelStore } from "@/stores/gitPanelStore";
import { useUIStore } from "@/stores/uiStore";
import { useProjectGitRepo } from "@/hooks/useProjectGitRepo";
import { focusFileExplorer } from "@/lib/workspaceLayout";
import { FolderTree, GitBranch, Search, FlaskConical } from "lucide-react";

export function WorkspacePanel() {
  const isNoProject = useProjectStore(selectIsNoProject);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const workspaceTab = useUIStore((s) => s.workspaceTab);
  const setWorkspaceTab = useUIStore((s) => s.setWorkspaceTab);

  // Eager per-project git-repo detection. Mounted before the CHAT
  // early-return because hooks cannot be conditional; the hook itself skips
  // the RPC for No Project, where the Git panel does not exist anyway.
  useProjectGitRepo();

  // The check result is only valid for the project it was checked against:
  // pairing the two fields prevents a stale answer from a previously active
  // project leaking into the layout during rapid project switches. While no
  // completed check belongs to this project the selector yields false, so
  // the non-git layout (the pre-feature default) renders until it lands.
  const isGitRepo = useGitPanelStore(
    (s) => s.isGitRepo && s.gitRepoProjectId === activeProjectId,
  );

  // Keep the transient workspaceTab valid for the current layout: the
  // Explorer tab exists only for non-git projects (a git project hosts the
  // explorer inside the Git panel's "files" section), and the Git tab only
  // for git projects. Runs on layout flips and project switches.
  useEffect(() => {
    if (isGitRepo && workspaceTab === "explorer") {
      focusFileExplorer();
    } else if (!isGitRepo && workspaceTab === "git") {
      setWorkspaceTab("explorer");
    }
  }, [isGitRepo, workspaceTab, setWorkspaceTab]);

  // In CHAT (No Project) mode, hide the tab strip entirely — only show the file
  // explorer with file-name search. Git and Semantics are unavailable anyway.
  if (isNoProject) {
    return (
      <TooltipProvider>
        <div className="flex h-full flex-col overflow-hidden">
          <FileTreePanel />
        </div>
      </TooltipProvider>
    );
  }

  // The tab actually rendered this frame. Until the effect above corrects
  // the store, a freshly switched project may still hold a tab value with
  // no trigger in the new layout (e.g. 'explorer' in a git project) — Radix
  // would render no content for it, so remap it inline for this render.
  const effectiveTab = isGitRepo
    ? workspaceTab === "explorer"
      ? "git"
      : workspaceTab
    : workspaceTab === "git"
      ? "explorer"
      : workspaceTab;

  return (
    <TooltipProvider>
      <Tabs value={effectiveTab} onValueChange={(v) => setWorkspaceTab(v as typeof workspaceTab)} className="flex h-full flex-col gap-0">
        <TabsList className="mx-1 h-8 shrink-0" variant="line">
          {isGitRepo ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <TabsTrigger value="git" className="px-2">
                  <GitBranch className="size-4" />
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Git</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <TabsTrigger value="explorer" className="px-2">
                  <FolderTree className="size-4" />
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Explorer</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="semantics" className="px-2">
                <Search className="size-4" />
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Search</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <TabsTrigger value="research" className="px-2">
                <FlaskConical className="size-4" />
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Research</TooltipContent>
          </Tooltip>
        </TabsList>

        {isGitRepo ? (
          <TabsContent value="git" className="flex-1 overflow-hidden">
            <GitPanel />
          </TabsContent>
        ) : (
          <TabsContent value="explorer" className="flex flex-col overflow-hidden">
            <FileTreePanel />
          </TabsContent>
        )}

        <TabsContent value="semantics" className="flex flex-col overflow-hidden">
          <VectorStorePanel />
        </TabsContent>

        <TabsContent value="research" className="flex-1 overflow-hidden">
          <ResearchPanel />
        </TabsContent>
      </Tabs>
    </TooltipProvider>
  );
}
