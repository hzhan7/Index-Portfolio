// Module worker for context / sample / alloc jobs.
import { serveWorker } from './engine/jobs.js?v=20260912';

serveWorker(self, ['context', 'sample', 'alloc']);
