import { Hono } from 'hono';

const models = new Hono();

export const AVAILABLE_MODELS = [
  {
    id: "qwen3.7-plus",
    object: "model",
    created: 1732711466,
    owned_by: "qwen"
  },
  {
    id: "qwen3.8-max",
    object: "model",
    created: 1732711466,
    owned_by: "qwen"
  }
];

models.get('/v1/models', (c) => {
  return c.json({
    object: "list",
    data: AVAILABLE_MODELS
  });
});

export default models;
