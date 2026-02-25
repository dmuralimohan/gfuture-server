import db from '../db.js';

export default async function categoryRoutes(fastify) {
  // GET /api/categories — list all (public)
  fastify.get('/', async () => {
    const categories = db.prepare('SELECT * FROM categories ORDER BY id').all();
    return { categories };
  });

  // GET /api/categories/:id
  fastify.get('/:id', async (request, reply) => {
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(request.params.id);
    if (!category) return reply.status(404).send({ message: 'Category not found' });
    return { category };
  });
}
