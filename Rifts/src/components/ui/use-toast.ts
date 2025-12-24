import React from 'react';
import type { ToastActionElement, ToastProps } from '@/components/ui/toast';

const TOAST_LIMIT = 1;

export interface Toast {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  duration?: number;
  variant?: 'default' | 'destructive';
}

interface ToastState {
  toasts: (Toast & {
    dismiss: () => void;
  })[];
}

type ToastListener = (state: ToastState) => void;

interface ToastStore {
  state: ToastState;
  listeners: ToastListener[];
  getState: () => ToastState;
  setState: (nextState: ToastState | ((prevState: ToastState) => ToastState)) => void;
  subscribe: (listener: ToastListener) => () => void;
}

let count = 0;

function generateId(): string {
  count = (count + 1) % Number.MAX_VALUE;
  return count.toString();
}

const toastStore: ToastStore = {
  state: {
    toasts: [],
  },
  listeners: [],
  
  getState: () => toastStore.state,
  
  setState: (nextState) => {
    if (typeof nextState === 'function') {
      toastStore.state = nextState(toastStore.state);
    } else {
      toastStore.state = { ...toastStore.state, ...nextState };
    }
    
    toastStore.listeners.forEach(listener => listener(toastStore.state));
  },
  
  subscribe: (listener) => {
    toastStore.listeners.push(listener);
    return () => {
      toastStore.listeners = toastStore.listeners.filter(l => l !== listener);
    };
  }
};

export interface ToastOptions extends Omit<Toast, 'id'> {}

export const toast = (props: ToastOptions) => {
  const id = generateId();

  const update = (updateProps: Partial<ToastOptions>) =>
    toastStore.setState((state) => ({
      ...state,
      toasts: state.toasts.map((t) =>
        t.id === id ? { ...t, ...updateProps } : t
      ),
    }));

  const dismiss = () => toastStore.setState((state) => ({
    ...state,
    toasts: state.toasts.filter((t) => t.id !== id),
  }));

  toastStore.setState((state) => ({
    ...state,
    toasts: [
      { ...props, id, dismiss },
      ...state.toasts,
    ].slice(0, TOAST_LIMIT),
  }));

  return {
    id,
    dismiss,
    update,
  };
};

export function useToast() {
  const [state, setState] = React.useState<ToastState>(toastStore.getState());
  
  React.useEffect(() => {
    const unsubscribe = toastStore.subscribe((state) => {
      setState(state);
    });
    
    return unsubscribe;
  }, []);
  
  React.useEffect(() => {
    const timeouts: NodeJS.Timeout[] = [];

    state.toasts.forEach((toastItem) => {
      if (toastItem.duration === Infinity) {
        return;
      }

      const timeout = setTimeout(() => {
        toastItem.dismiss();
      }, toastItem.duration || 5000);

      timeouts.push(timeout);
    });

    return () => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
    };
  }, [state.toasts]);

  return {
    toast,
    toasts: state.toasts,
  };
}