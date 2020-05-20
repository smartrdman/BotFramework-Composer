// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** @jsx jsx */
import { jsx } from '@emotion/core';
import { useContext, FC, useEffect, useRef } from 'react';
import { MarqueeSelection } from 'office-ui-fabric-react/lib/MarqueeSelection';
import { SDKKinds, DialogUtils } from '@bfc/shared';
import { useDialogApi, useDialogEditApi, useActionApi, useShellApi } from '@bfc/extension';
import get from 'lodash/get';

import { NodeEventTypes } from '../constants/NodeEventTypes';
import { ScreenReaderMessage } from '../constants/ScreenReaderMessage';
import { AttrNames } from '../constants/ElementAttributes';
import { NodeRendererContext } from '../store/NodeRendererContext';
import { normalizeSelection } from '../utils/normalizeSelection';
import { KeyboardZone } from '../components/lib/KeyboardZone';
import { scrollNodeIntoView } from '../utils/nodeOperation';
import { designerCache } from '../store/DesignerCache';
import { MenuEventTypes } from '../constants/MenuTypes';
import { useKeyboardApi } from '../hooks/useKeyboardApi';
import { useSelectionApi } from '../hooks/useSelectionApi';

import { AdaptiveDialogEditor } from './AdaptiveDialogEditor';

export const ObiEditor: FC<ObiEditorProps> = ({
  path,
  data,
  onFocusEvent,
  onFocusSteps,
  onClipboardChange,
  onOpen,
  onChange,
  undo,
  redo,
  announce,
}): JSX.Element | null => {
  const { focusedId, focusedEvent, clipboardActions, dialogFactory } = useContext(NodeRendererContext);
  const { shellApi } = useShellApi();
  const {
    insertAction,
    insertActions,
    insertActionsAfter,
    copySelectedActions,
    cutSelectedActions,
    deleteSelectedAction,
    deleteSelectedActions,
    updateRecognizer,
  } = useDialogEditApi(shellApi);
  const { createDialog, readDialog, updateDialog } = useDialogApi(shellApi);
  const { actionsContainLuIntent } = useActionApi(shellApi);
  const { selection, selectedIds } = useSelectionApi();
  const divRef = useRef<HTMLDivElement>(null);

  // send focus to the keyboard area when navigating to a new trigger
  useEffect(() => {
    divRef.current?.focus();
  }, [focusedEvent]);

  const trackActionChange = (actionPath: string) => {
    const affectedPaths = DialogUtils.getParentPaths(actionPath);
    for (const path of affectedPaths) {
      const json = get(data, path);
      designerCache.uncacheBoundary(json);
    }
  };

  const trackActionListChange = (actionPaths: string[]) => {
    if (!Array.isArray(actionPaths)) return;
    actionPaths.forEach(x => trackActionChange(x));
  };

  const dispatchEvent = (eventName: NodeEventTypes, eventData: any = {}): any => {
    let handler;
    switch (eventName) {
      case NodeEventTypes.Focus:
        handler = (e: { id: string; tab?: string }) => {
          const newFocusedIds = e.id ? [e.id] : [];
          setSelectedIds([...newFocusedIds]);
          onFocusSteps([...newFocusedIds], e.tab);
          announce(ScreenReaderMessage.ActionFocused);
        };
        break;
      case NodeEventTypes.FocusEvent:
        handler = eventData => {
          onFocusEvent(eventData);
          announce(ScreenReaderMessage.EventFocused);
        };
        break;
      case NodeEventTypes.MoveCursor:
        handler = eventData => {
          const { selected, focused, tab } = eventData;
          setSelectedIds([selected as string]);
          focused && onFocusSteps([focused], tab);
          scrollNodeIntoView(`[${AttrNames.SelectedId}="${selected}"]`);
          announce(ScreenReaderMessage.ActionFocused);
        };
        break;
      case NodeEventTypes.OpenDialog:
        handler = ({ caller, callee }) => {
          onOpen(callee, caller);
          announce(ScreenReaderMessage.DialogOpened);
        };
        break;
      case NodeEventTypes.Delete:
        trackActionChange(eventData.id);
        handler = e => {
          onChange(deleteSelectedAction(path, data, e.id));
          onFocusSteps([]);
          announce(ScreenReaderMessage.ActionDeleted);
        };
        break;
      case NodeEventTypes.Insert:
        trackActionChange(eventData.id);
        if (eventData.$kind === MenuEventTypes.Paste) {
          handler = e => {
            insertActions(path, data, e.id, e.position, clipboardActions).then(dialog => {
              onChange(dialog);
              onFocusSteps([`${e.id}[${e.position || 0}]`]);
            });
            announce(ScreenReaderMessage.ActionCreated);
          };
        } else {
          handler = e => {
            const newAction = dialogFactory.create(e.$kind);
            insertAction(path, data, e.id, e.position, newAction).then(dialog => {
              onChange(dialog);
              onFocusSteps([`${e.id}[${e.position || 0}]`]);
              announce(ScreenReaderMessage.ActionCreated);
            });
          };
        }
        break;
      case NodeEventTypes.CopySelection:
        handler = () => {
          const actionIds = getClipboardTargetsFromContext();
          copySelectedActions(path, data, actionIds).then(copiedNodes => onClipboardChange(copiedNodes));
          announce(ScreenReaderMessage.ActionsCopied);
        };
        break;
      case NodeEventTypes.CutSelection:
        handler = () => {
          const actionIds = getClipboardTargetsFromContext();
          trackActionListChange(actionIds);
          cutSelectedActions(path, data, actionIds).then(({ dialog, cutActions }) => {
            onChange(dialog);
            onFocusSteps([]);
            onClipboardChange(cutActions);
          });
          announce(ScreenReaderMessage.ActionsCut);
        };
        break;
      case NodeEventTypes.MoveSelection:
        handler = async () => {
          const actionIds = getClipboardTargetsFromContext();
          if (!Array.isArray(actionIds) || !actionIds.length) return;

          // Create target dialog
          const newDialogId = await createDialog();
          if (!newDialogId) return;
          let newDialogData = readDialog(newDialogId);

          // Using copy->paste->delete pattern is safer than using cut->paste
          const actionsToBeMoved = await copySelectedActions(path, data, actionIds);
          newDialogData = await insertActions(
            newDialogId,
            newDialogData,
            `${'triggers'}[0].${'actions'}`,
            0,
            actionsToBeMoved
          );
          if (actionsContainLuIntent(actionsToBeMoved)) {
            // auto assign recognizer type to lu
            newDialogData = updateRecognizer(path, newDialogData, `${newDialogId}.lu`);
          }
          updateDialog(newDialogId, newDialogData);

          // Delete moved actions
          const deleteResult = deleteSelectedActions(path, data, actionIds);

          // Insert a BeginDialog as placeholder
          const placeholderPosition = DialogUtils.parseNodePath(actionIds[0]);
          if (!placeholderPosition) return;

          const placeholderAction = dialogFactory.create(SDKKinds.BeginDialog, { dialog: newDialogId });
          const insertResult = await insertAction(
            path,
            deleteResult,
            placeholderPosition.arrayPath,
            placeholderPosition.arrayIndex,
            placeholderAction
          );
          onChange(insertResult);
          onFocusSteps([]);
          announce(ScreenReaderMessage.ActionsMoved);
        };
        break;
      case NodeEventTypes.DeleteSelection:
        handler = () => {
          const actionIds = getClipboardTargetsFromContext();
          trackActionListChange(actionIds);
          onChange(deleteSelectedActions(path, data, actionIds));
          onFocusSteps([]);
          announce(ScreenReaderMessage.ActionsDeleted);
        };
        break;
      case NodeEventTypes.AppendSelection:
        handler = e => {
          trackActionListChange(e.target);
          // forbid paste to root level.
          if (!e.target || e.target === focusedEvent) return;
          onChange(insertActionsAfter(path, data, e.target, e.actions));
          announce(ScreenReaderMessage.ActionsCreated);
        };
        break;
      case NodeEventTypes.Undo:
        handler = () => {
          undo?.();
          announce(ScreenReaderMessage.ActionUndo);
        };
        break;
      case NodeEventTypes.Redo:
        handler = () => {
          redo?.();
          announce(ScreenReaderMessage.ActionUndo);
        };
        break;
      default:
        handler = onFocusSteps;
        break;
    }
    return handler(eventData);
  };
  const { handleKeyboardCommand } = useKeyboardApi(dispatchEvent);

  const renderFallbackContent = () => {
    return null;
  };

  const getClipboardTargetsFromContext = (): string[] => {
    const selectedActionIds = normalizeSelection(selectedIds);
    if (selectedActionIds.length === 0 && focusedId) {
      selectedActionIds.push(focusedId);
    }
    return selectedActionIds;
  };

  // HACK: use global handler before we solve iframe state sync problem
  (window as any).copySelection = () => dispatchEvent(NodeEventTypes.CopySelection);
  (window as any).cutSelection = () => dispatchEvent(NodeEventTypes.CutSelection);
  (window as any).moveSelection = () => dispatchEvent(NodeEventTypes.MoveSelection);
  (window as any).deleteSelection = () => dispatchEvent(NodeEventTypes.DeleteSelection);

  if (!data) return renderFallbackContent();
  return (
    <KeyboardZone onCommand={handleKeyboardCommand} ref={divRef}>
      <MarqueeSelection selection={selection} css={{ width: '100%', height: '100%' }}>
        <div
          className="obi-editor-container"
          data-testid="obi-editor-container"
          css={{
            width: '100%',
            height: '100%',
            padding: '48px 20px',
            boxSizing: 'border-box',
          }}
          onClick={e => {
            e.stopPropagation();
            dispatchEvent(NodeEventTypes.Focus, { id: '' });
          }}
        >
          <AdaptiveDialogEditor
            id={path}
            data={data}
            onEvent={(eventName, eventData) => {
              divRef.current?.focus({ preventScroll: true });
              dispatchEvent(eventName, eventData);
            }}
          />
        </div>
      </MarqueeSelection>
    </KeyboardZone>
  );
};

ObiEditor.defaultProps = {
  path: '.',
  data: {},
  focusedSteps: [],
  onFocusSteps: () => {},
  onFocusEvent: () => {},
  onClipboardChange: () => {},
  onOpen: () => {},
  onChange: () => {},
  onSelect: () => {},
  undo: () => {},
  redo: () => {},
  announce: (message: string) => {},
};

interface ObiEditorProps {
  path: string;
  // Obi raw json
  data: any;
  focusedSteps: string[];
  onFocusSteps: (stepIds: string[], fragment?: string) => any;
  onFocusEvent: (eventId: string) => any;
  onClipboardChange: (actions: any[]) => void;
  onCreateDialog: (actions: any[]) => Promise<string | null>;
  onOpen: (calleeDialog: string, callerId: string) => any;
  onChange: (newDialog: any) => any;
  onSelect: (ids: string[]) => any;
  undo?: () => any;
  redo?: () => any;
  announce: (message: string) => any;
}
