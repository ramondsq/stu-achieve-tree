const crypto = require('crypto');

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const KNOWLEDGE_NODE_KEY = 'cpp_algorithm_level_1';
const REWARD_NODE_KEY = 'weekly_bounty_level_1';
const TEACHER_USERNAME = process.env.SMOKE_TEACHER_USERNAME || '';
const TEACHER_PASSWORD = process.env.SMOKE_TEACHER_PASSWORD || '';
const PRESET_TEACHER_TOKEN = process.env.SMOKE_TEACHER_TOKEN || '';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(path, options = {}) {
  const {
    method = 'GET',
    token = '',
    body,
  } = options;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_err) {
  }

  if (!response.ok) {
    throw new Error(`${method} ${path} failed: HTTP ${response.status} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }

  return payload;
}

async function resolveTeacherToken() {
  if (PRESET_TEACHER_TOKEN) {
    return PRESET_TEACHER_TOKEN;
  }

  assert(TEACHER_USERNAME && TEACHER_PASSWORD, '缺少老师凭据：请设置 SMOKE_TEACHER_TOKEN，或同时设置 SMOKE_TEACHER_USERNAME / SMOKE_TEACHER_PASSWORD');
  const payload = await api('/api/teacher/login', {
    method: 'POST',
    body: {
      username: TEACHER_USERNAME,
      password: TEACHER_PASSWORD,
    },
  });
  assert(payload && payload.token, '老师登录成功但未返回 token');
  return payload.token;
}

async function expectHttpFailure(expectedStatus, path, options = {}) {
  try {
    await api(path, options);
  } catch (err) {
    assert(
      String(err.message || '').includes(`HTTP ${expectedStatus}`),
      `期望 ${path} 返回 HTTP ${expectedStatus}，实际错误为：${err.message}`,
    );
    return;
  }
  throw new Error(`期望 ${path} 返回 HTTP ${expectedStatus}，但请求成功了`);
}

function createTempStudentPayload() {
  const suffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  return {
    username: `smoke_${suffix}`,
    password: `Smoke_${suffix}`,
    name: '冒烟测试学生',
  };
}

function findSystemNodeId(settings, systemKey) {
  for (const tree of settings.trees || []) {
    const node = (tree.nodes || []).find((item) => item.system_key === systemKey);
    if (node) {
      return node.id;
    }
  }
  return null;
}

async function main() {
  console.log(`[smoke] base url: ${BASE_URL}`);
  const teacherToken = await resolveTeacherToken();
  console.log('[smoke] teacher auth ready');

  const health = await api('/api/health');
  assert(health && health.ok, '健康检查失败');
  console.log('[smoke] health ok');

  const systemSettings = await api('/api/system-tree-settings', { token: teacherToken });
  assert(Array.isArray(systemSettings.trees) && systemSettings.trees.length >= 2, '系统树设置返回异常');

  const knowledgeNodeId = findSystemNodeId(systemSettings, KNOWLEDGE_NODE_KEY);
  const rewardNodeId = findSystemNodeId(systemSettings, REWARD_NODE_KEY);
  assert(knowledgeNodeId, `未找到系统节点 ${KNOWLEDGE_NODE_KEY}`);
  assert(rewardNodeId, `未找到系统节点 ${REWARD_NODE_KEY}`);
  console.log('[smoke] system tree settings ok');

  const tempStudent = createTempStudentPayload();
  let createdStudent = null;
  let createdTree = null;

  try {
    createdStudent = await api('/api/students', {
      method: 'POST',
      token: teacherToken,
      body: tempStudent,
    });
    assert(createdStudent && createdStudent.id, '创建测试学生失败');
    console.log(`[smoke] created student ${createdStudent.username} (#${createdStudent.id})`);

    const studentLogin = await api('/api/student/login', {
      method: 'POST',
      body: {
        username: tempStudent.username,
        password: tempStudent.password,
      },
    });
    assert(studentLogin && studentLogin.token, '学生登录失败');
    const studentToken = studentLogin.token;

    const studentBefore = await api('/api/student/me', { token: studentToken });
    assert(Number(studentBefore.level || 0) === 0, '新学生初始等级不是 0');
    assert(Number(studentBefore.total_points || 0) === 0, '新学生初始积分不是 0');
    console.log('[smoke] student login ok');

    const knowledgeSubmission = await api('/api/student/node-submissions', {
      method: 'POST',
      token: studentToken,
      body: {
        nodeId: knowledgeNodeId,
        codeText: 'for (int i = 0; i < 10; i++) {}',
      },
    });
    assert(knowledgeSubmission && knowledgeSubmission.id, '知识点提交失败');

    await api(`/api/submissions/${knowledgeSubmission.id}/score`, {
      method: 'PUT',
      token: teacherToken,
      body: {
        score: 8,
        comment: '知识点达标',
      },
    });

    const studentAfterKnowledge = await api('/api/student/me', { token: studentToken });
    assert(Number(studentAfterKnowledge.level || 0) >= 1, '知识点批改后学生没有升级到至少 1 级');
    console.log('[smoke] knowledge tree upgrade ok');

    createdTree = await api('/api/trees', {
      method: 'POST',
      token: teacherToken,
      body: {
        title: `前置条件冒烟树_${Date.now()}`,
        rootName: '前置条件根节点',
        chapterDesc: '用于验证节点前置条件 v2',
      },
    });
    assert(createdTree && createdTree.id, '创建前置条件测试树失败');

    const createdNodes = await api(`/api/trees/${createdTree.id}/nodes`, { token: teacherToken });
    const rootNode = createdNodes.find((item) => item.parent_id === null);
    assert(rootNode && rootNode.id, '前置条件测试树未返回根节点');

    const prerequisiteNode = await api(`/api/trees/${createdTree.id}/nodes`, {
      method: 'POST',
      token: teacherToken,
      body: {
        parentId: rootNode.id,
        name: '比较运算符',
        sortOrder: 0,
        milestoneLevel: 0,
        requiredLevel: 0,
        unlockPrerequisites: [],
        unlockPrerequisiteMode: 'all',
      },
    });
    const lockedNode = await api(`/api/trees/${createdTree.id}/nodes`, {
      method: 'POST',
      token: teacherToken,
      body: {
        parentId: rootNode.id,
        name: '循环',
        sortOrder: 1,
        milestoneLevel: 0,
        requiredLevel: 0,
        unlockPrerequisites: [{
          sourceNodeId: prerequisiteNode.id,
          thresholdPercent: 80,
        }],
        unlockPrerequisiteMode: 'all',
      },
    });
    assert(prerequisiteNode && prerequisiteNode.id, '创建前置节点失败');
    assert(lockedNode && lockedNode.id, '创建被锁节点失败');

    await expectHttpFailure(403, '/api/student/node-submissions', {
      method: 'POST',
      token: studentToken,
      body: {
        nodeId: lockedNode.id,
        codeText: 'while (true) { break; }',
      },
    });
    console.log('[smoke] prerequisite lock blocks submission before source node is complete');

    const prerequisiteSubmission = await api('/api/student/node-submissions', {
      method: 'POST',
      token: studentToken,
      body: {
        nodeId: prerequisiteNode.id,
        codeText: 'if (a < b) { return 1; }',
      },
    });
    assert(prerequisiteSubmission && prerequisiteSubmission.id, '前置节点提交失败');

    await api(`/api/submissions/${prerequisiteSubmission.id}/score`, {
      method: 'PUT',
      token: teacherToken,
      body: {
        score: 8,
        comment: '前置节点达标',
      },
    });

    const unlockedSubmission = await api('/api/student/node-submissions', {
      method: 'POST',
      token: studentToken,
      body: {
        nodeId: lockedNode.id,
        codeText: 'for (;;) { break; }',
      },
    });
    assert(unlockedSubmission && unlockedSubmission.id, '前置节点达标后，目标节点仍无法提交');
    console.log('[smoke] prerequisite unlock works after source node reaches threshold');

    const subtreeSourceA = await api(`/api/trees/${createdTree.id}/nodes`, {
      method: 'POST',
      token: teacherToken,
      body: {
        parentId: rootNode.id,
        name: 'GESP 一级',
        sortOrder: 2,
        milestoneLevel: 0,
        requiredLevel: 0,
        unlockPrerequisites: [],
        unlockPrerequisiteMode: 'all',
      },
    });
    const subtreeSourceALeaf = await api(`/api/trees/${createdTree.id}/nodes`, {
      method: 'POST',
      token: teacherToken,
      body: {
        parentId: subtreeSourceA.id,
        name: '标准输入输出',
        sortOrder: 0,
        milestoneLevel: 0,
        requiredLevel: 0,
        unlockPrerequisites: [],
        unlockPrerequisiteMode: 'all',
      },
    });
    const subtreeSourceB = await api(`/api/trees/${createdTree.id}/nodes`, {
      method: 'POST',
      token: teacherToken,
      body: {
        parentId: rootNode.id,
        name: 'GESP 二级',
        sortOrder: 3,
        milestoneLevel: 0,
        requiredLevel: 0,
        unlockPrerequisites: [],
        unlockPrerequisiteMode: 'all',
      },
    });
    const subtreeSourceBLeaf = await api(`/api/trees/${createdTree.id}/nodes`, {
      method: 'POST',
      token: teacherToken,
      body: {
        parentId: subtreeSourceB.id,
        name: '数组循环',
        sortOrder: 0,
        milestoneLevel: 0,
        requiredLevel: 0,
        unlockPrerequisites: [],
        unlockPrerequisiteMode: 'all',
      },
    });
    const anyModeTarget = await api(`/api/trees/${createdTree.id}/nodes`, {
      method: 'POST',
      token: teacherToken,
      body: {
        parentId: rootNode.id,
        name: '综合练习',
        sortOrder: 4,
        milestoneLevel: 0,
        requiredLevel: 0,
        unlockPrerequisites: [
          {
            sourceNodeId: subtreeSourceA.id,
            thresholdPercent: 80,
          },
          {
            sourceNodeId: subtreeSourceB.id,
            thresholdPercent: 80,
          },
        ],
        unlockPrerequisiteMode: 'any',
      },
    });
    assert(subtreeSourceALeaf && subtreeSourceALeaf.id, '创建子树前置叶子 A 失败');
    assert(subtreeSourceBLeaf && subtreeSourceBLeaf.id, '创建子树前置叶子 B 失败');
    assert(anyModeTarget && anyModeTarget.id, '创建任一满足目标节点失败');

    await expectHttpFailure(403, '/api/student/node-submissions', {
      method: 'POST',
      token: studentToken,
      body: {
        nodeId: anyModeTarget.id,
        codeText: 'cout << "target";',
      },
    });

    const subtreeSourceSubmission = await api('/api/student/node-submissions', {
      method: 'POST',
      token: studentToken,
      body: {
        nodeId: subtreeSourceALeaf.id,
        codeText: 'cout << "subtree";',
      },
    });
    assert(subtreeSourceSubmission && subtreeSourceSubmission.id, '子树前置叶子提交失败');

    await api(`/api/submissions/${subtreeSourceSubmission.id}/score`, {
      method: 'PUT',
      token: teacherToken,
      body: {
        score: 8,
        comment: '子树前置达标',
      },
    });

    const anyModeUnlockedSubmission = await api('/api/student/node-submissions', {
      method: 'POST',
      token: studentToken,
      body: {
        nodeId: anyModeTarget.id,
        codeText: 'cout << "any";',
      },
    });
    assert(anyModeUnlockedSubmission && anyModeUnlockedSubmission.id, '任一满足模式未按预期解锁目标节点');
    console.log('[smoke] any-mode prerequisite unlock works with subtree progress');

    const rewardSubmission = await api('/api/student/node-submissions', {
      method: 'POST',
      token: studentToken,
      body: {
        nodeId: rewardNodeId,
        codeText: 'reward answer',
      },
    });
    assert(rewardSubmission && rewardSubmission.id, '悬赏任务提交失败');

    await api(`/api/submissions/${rewardSubmission.id}/score`, {
      method: 'PUT',
      token: teacherToken,
      body: {
        score: 8,
        comment: '悬赏任务达标',
      },
    });

    const studentAfterReward = await api('/api/student/me', { token: studentToken });
    assert(Number(studentAfterReward.total_points || 0) >= 1, '悬赏任务批改后积分未到账');
    console.log('[smoke] reward tree points ok');

    console.log('[smoke] all checks passed');
  } finally {
    if (createdTree && createdTree.id) {
      try {
        await api(`/api/trees/${createdTree.id}`, {
          method: 'DELETE',
          token: teacherToken,
        });
        console.log(`[smoke] cleaned tree #${createdTree.id}`);
      } catch (cleanupErr) {
        console.error('[smoke] tree cleanup failed:', cleanupErr.message);
      }
    }
    if (createdStudent && createdStudent.id) {
      try {
        await api(`/api/students/${createdStudent.id}`, {
          method: 'DELETE',
          token: teacherToken,
        });
        console.log(`[smoke] cleaned student #${createdStudent.id}`);
      } catch (cleanupErr) {
        console.error('[smoke] cleanup failed:', cleanupErr.message);
      }
    }
  }
}

main().catch((err) => {
  console.error('[smoke] failed:', err.message);
  process.exit(1);
});
