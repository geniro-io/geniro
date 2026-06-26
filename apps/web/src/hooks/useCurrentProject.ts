import axios from 'axios';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';

import { useProjectContext } from '../contexts/ProjectContext';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const useCurrentProject = () => {
  const { projectId: urlProjectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const {
    projects,
    loading,
    loadProjects,
    currentProjectId,
    setCurrentProjectId,
  } = useProjectContext();

  // Sync URL projectId to context/localStorage. Guard against a URL pointing to
  // a project the user can't access (deleted, or never theirs): writing it here
  // would fight ProjectProvider's "reset selection to the first project" effect
  // and spin into an infinite update loop ("Maximum update depth exceeded").
  // While the list is still loading we can't yet tell, so sync optimistically —
  // ProjectProvider's reset is itself gated on `!loading`.
  useEffect(() => {
    if (!urlProjectId || urlProjectId === currentProjectId) {
      return;
    }
    if (loading || projects.some((p) => p.id === urlProjectId)) {
      setCurrentProjectId(urlProjectId);
    }
  }, [urlProjectId, currentProjectId, setCurrentProjectId, loading, projects]);

  // Once the project list is known, a URL pointing to a project that isn't in it
  // is unreachable (deleted / not the user's). Redirect to the project list
  // rather than leave the app rendering another project's data under the wrong
  // URL (previously this state looped instead of resolving).
  useEffect(() => {
    if (!urlProjectId || loading || projects.length === 0) {
      return;
    }
    if (!projects.some((p) => p.id === urlProjectId)) {
      navigate('/projects', { replace: true });
    }
  }, [urlProjectId, loading, projects, navigate]);

  // Effective project: URL wins, then localStorage context
  const projectId = urlProjectId ?? currentProjectId ?? undefined;
  const currentProject = projects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (projectId && UUID_RE.test(projectId)) {
      axios.defaults.headers.common['X-Project-Id'] = projectId;
    } else {
      delete axios.defaults.headers.common['X-Project-Id'];
    }
  }, [projectId]);

  return { projectId, currentProject, projects, loading, loadProjects };
};
