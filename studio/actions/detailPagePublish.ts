import { useDocumentOperation, type DocumentActionComponent, type DocumentActionsResolver } from 'sanity';
import { detailPages, featuredProjects } from '../../src/config/projects.ts';
import { detailPagePatch, type DetailPageDocument } from '../schemaTypes/projectRules.ts';

const localFeaturedRepos = featuredProjects.map((f) => f.repo);

/**
 * Wraps Sanity's built-in Publish action for `project` documents: right before publishing it records that the project
 * has a detail page (`detailPageEnabled`) and stores a generated slug if none exists (rules: detailPagePatch).
 *
 * The write is a normal patch of the document being published, made with the editor's own Studio session as part of
 * the publish they started – no build-time writes, no tokens, no bulk changes. Publishing itself (validation,
 * permissions, disabled states) is left entirely to the original action.
 */
export function withDetailPageActivation(publish: DocumentActionComponent): DocumentActionComponent {
  const Action: DocumentActionComponent = (props) => {
    const { patch } = useDocumentOperation(props.id, props.type);
    const description = publish(props);
    if (!description) return description;
    return {
      ...description,
      onHandle: () => {
        const set = detailPagePatch(
          (props.draft ?? props.published) as DetailPageDocument | null,
          props.published as DetailPageDocument | null,
          localFeaturedRepos,
          detailPages,
        );
        if (set && !patch.disabled) patch.execute([{ set }]);
        description.onHandle?.();
      },
    };
  };
  Action.action = publish.action;
  Action.displayName = 'DetailPagePublishAction';
  return Action;
}

/** Document actions: only the project type's Publish action is wrapped; everything else is unchanged. */
export const documentActions: DocumentActionsResolver = (prev, context) =>
  context.schemaType === 'project' ? prev.map((a) => (a.action === 'publish' ? withDetailPageActivation(a) : a)) : prev;
