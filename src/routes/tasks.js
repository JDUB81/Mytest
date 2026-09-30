const express = require('express');
const { text, date } = require('../format');
const { logActivity, today } = require('../deals');

module.exports = function taskRoutes(db) {
  const router = express.Router();

  const staff = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name');
  const insertTask = db.prepare(`
    INSERT INTO tasks (title, details, due_date, customer_id, assigned_to, created_by) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const completeTask = db.prepare("UPDATE tasks SET done_at = datetime('now'), done_by = ? WHERE id = ? AND done_at IS NULL");
  const reopenTask = db.prepare('UPDATE tasks SET done_at = NULL, done_by = NULL WHERE id = ?');
  const deleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
  const customerExists = db.prepare('SELECT id, first_name, last_name FROM customers WHERE id = ?');

  function back(req, task) {
    if (req.body.from === 'customer' && task.customer_id) return `/customers/${task.customer_id}#tasks`;
    if (req.body.from === 'dashboard') return '/';
    return '/tasks';
  }

  router.get('/', (req, res) => {
    const view = ['mine', 'all', 'done'].includes(req.query.view) ? req.query.view : 'mine';
    const where = [];
    const params = {};
    if (view === 'done') where.push('t.done_at IS NOT NULL');
    else where.push('t.done_at IS NULL');
    if (view === 'mine') {
      where.push('t.assigned_to = @me');
      params.me = req.user.id;
    }
    const tasks = db
      .prepare(`
        SELECT t.*, u.full_name AS assigned_name, c.first_name, c.last_name, cb.full_name AS created_by_name
        FROM tasks t
        LEFT JOIN users u ON u.id = t.assigned_to
        LEFT JOIN users cb ON cb.id = t.created_by
        LEFT JOIN customers c ON c.id = t.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${view === 'done' ? 't.done_at DESC' : 't.due_date IS NULL, t.due_date, t.id'}
        LIMIT 500
      `)
      .all(params);
    const customers = db
      .prepare("SELECT id, first_name, last_name FROM customers WHERE lead_status NOT IN ('lost') ORDER BY last_name, first_name")
      .all();
    res.render('tasks/index', { title: 'Tasks', tasks, view, staff: staff.all(), customers, todayStr: today() });
  });

  router.post('/', (req, res) => {
    const title = text(req.body.title, 200);
    const due = date(req.body.due_date);
    const customer = req.body.customer_id ? customerExists.get(Number(req.body.customer_id)) : null;
    const assignee = staff.all().find((u) => u.id === Number(req.body.assigned_to));
    const fakeTask = { customer_id: customer ? customer.id : null };
    if (!title || due.error) {
      req.flash('error', 'Give the task a title and a valid due date.');
      return res.redirect(back(req, fakeTask));
    }
    insertTask.run(
      title,
      text(req.body.details, 2000),
      due.value,
      customer ? customer.id : null,
      assignee ? assignee.id : req.user.id,
      req.user.id
    );
    if (customer) {
      logActivity(db, {
        userId: req.user.id,
        customerId: customer.id,
        message: `Task added: "${title}"${due.value ? ` due ${due.value}` : ''}${assignee && assignee.id !== req.user.id ? ` for ${assignee.full_name}` : ''}`,
      });
    }
    req.flash('success', 'Task added.');
    res.redirect(back(req, fakeTask));
  });

  router.post('/:id/done', (req, res) => {
    const task = selectTask.get(Number(req.params.id));
    if (!task) return res.redirect('/tasks');
    if (completeTask.run(req.user.id, task.id).changes && task.customer_id) {
      logActivity(db, { userId: req.user.id, customerId: task.customer_id, message: `Completed task: "${task.title}"` });
    }
    res.redirect(back(req, task));
  });

  router.post('/:id/reopen', (req, res) => {
    const task = selectTask.get(Number(req.params.id));
    if (task) reopenTask.run(task.id);
    res.redirect(task ? back(req, task) : '/tasks');
  });

  router.post('/:id/delete', (req, res) => {
    const task = selectTask.get(Number(req.params.id));
    if (!task) return res.redirect('/tasks');
    if (task.created_by !== req.user.id && req.user.role !== 'manager') {
      return res.status(403).render('error', { title: 'Access denied', message: 'Only the person who created a task or a manager can delete it.' });
    }
    deleteTask.run(task.id);
    req.flash('success', 'Task deleted.');
    res.redirect(back(req, task));
  });

  return router;
};
