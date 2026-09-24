'use server';

import { randomUUID } from 'node:crypto';
import { ApiError } from '../../lib/api';
import {
  CaptureInputRefused,
  captureInputFromForm,
  captureObservation,
} from '../../lib/api/capture';
import { webCaller } from '../../lib/session';
import type { CaptureState } from './state';

/** The capture form's one server action: `POST /capture/observation`, and nothing else. */
export async function captureNote(previous: CaptureState, form: FormData): Promise<CaptureState> {
  let input;
  try {
    input = captureInputFromForm(form);
  } catch (error: unknown) {
    if (error instanceof CaptureInputRefused) {
      return { status: 'refused', gestureId: previous.gestureId, message: error.message };
    }
    throw error;
  }
  try {
    const outcome = await captureObservation(input, await webCaller('/capture'));
    return { status: 'recorded', gestureId: randomUUID(), outcome };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isRefusal) {
      return { status: 'refused', gestureId: input.gestureId, message: error.message };
    }
    throw error;
  }
}
