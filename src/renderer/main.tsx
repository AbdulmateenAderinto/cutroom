import { createRoot } from 'react-dom/client';
import type { CutroomApi } from '../preload/api';
import { App } from './App';
import './styles/app.css';

declare global {
  interface Window {
    cutroom: CutroomApi;
  }
}

createRoot(document.getElementById('root')!).render(<App />);
