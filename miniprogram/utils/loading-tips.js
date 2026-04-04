const TIP_LIBRARY = [
  {
    key: 'history-eniac',
    category: '计算机历史',
    title: 'ENIAC',
    content: '1946 年 ENIAC 问世，通常被视为最早的通用电子数字计算机之一。',
  },
  {
    key: 'history-unix',
    category: '计算机历史',
    title: 'Unix',
    content: '1969 年诞生的 Unix 深刻影响了 Linux、macOS 以及今天大量开发工具的设计。',
  },
  {
    key: 'history-web',
    category: '计算机历史',
    title: '万维网',
    content: '1989 年 Tim Berners-Lee 提出 World Wide Web，让互联网从网络基础设施走向大众信息空间。',
  },
  {
    key: 'history-open-source',
    category: '计算机历史',
    title: '开源协作',
    content: 'Git 和开源社区让多人协作写大型程序成为常态，现代软件工程因此提速很多。',
  },
  {
    key: 'algo-greedy',
    category: '算法思想',
    title: '贪心',
    content: '贪心不是“每次选最大的”这么简单，关键是先证明局部最优能推出全局最优。',
  },
  {
    key: 'algo-binary-search',
    category: '算法思想',
    title: '二分答案',
    content: '当答案具有单调性时，别只对数组做二分，很多“最小值最大值”题都能二分答案。',
  },
  {
    key: 'algo-state',
    category: '算法思想',
    title: '状态设计',
    content: '动态规划先写“状态表示什么”，再写转移；状态定义不清，转移通常也会跟着混乱。',
  },
  {
    key: 'algo-complexity',
    category: '算法思想',
    title: '复杂度',
    content: '做题时先估数量级：n 是 1e5 还是 1e3，往往比一开始就写代码更重要。',
  },
  {
    key: 'syntax-eq',
    category: '语法提醒',
    title: '= 和 ==',
    content: 'C++ 里 = 是赋值，== 才是比较；条件里写错一个等号，是非常常见的失分点。',
  },
  {
    key: 'syntax-division',
    category: '语法提醒',
    title: '整数除法',
    content: '在 C++ 中 5 / 2 的结果是 2，不是 2.5；只要参与运算的都是整数，就会发生截断。',
  },
  {
    key: 'syntax-boundary',
    category: '语法提醒',
    title: '循环边界',
    content: 'for 循环最容易错的不是语法，而是边界：< n、<= n - 1、从 0 还是从 1 开始。',
  },
  {
    key: 'syntax-braces',
    category: '语法提醒',
    title: '花括号',
    content: 'if 或 for 只有一条语句时虽然可以省略花括号，但调试和改题时很容易埋坑。',
  },
  {
    key: 'syntax-semicolon',
    category: '语法提醒',
    title: '分号',
    content: 'if、for、while 后面多写一个分号，程序仍能编译，但逻辑通常已经悄悄错了。',
  },
  {
    key: 'syntax-array-index',
    category: '语法提醒',
    title: '数组下标',
    content: '数组越界往往不会立刻报错，0 到 n - 1 和 1 到 n 的边界一定要先想清楚。',
  },
  {
    key: 'syntax-char-string',
    category: '语法提醒',
    title: '字符与字符串',
    content: '\'a\' 是字符，"a" 是字符串；类型不同，比较和赋值时不能混着想。',
  },
  {
    key: 'syntax-scope',
    category: '语法提醒',
    title: '变量作用域',
    content: '在循环或 if 里新定义同名变量，会遮住外层变量，调试时很容易误判值的来源。',
  },
  {
    key: 'syntax-read-order',
    category: '语法提醒',
    title: '输入顺序',
    content: '题目给什么顺序就按什么顺序读，变量名可以自己起，但输入顺序一乱，结果通常全错。',
  },
  {
    key: 'noi-lou',
    category: '信奥人物',
    title: '楼天城',
    content: '楼天城曾获 IOI 金牌，后来长期活跃在高性能系统与量化工程领域。',
  },
  {
    key: 'noi-chen',
    category: '信奥人物',
    title: '陈丹琦',
    content: '陈丹琦在中学阶段参加过信息学竞赛，后来参与提出 Transformer。',
  },
  {
    key: 'noi-yinqi',
    category: '信奥人物',
    title: '印奇',
    content: '印奇有信息学竞赛背景，后来创办了以计算机视觉闻名的科技公司。',
  },
  {
    key: 'noi-growth',
    category: '信奥人物',
    title: '训练价值',
    content: '很多信奥出身的人后来并不只写竞赛代码，但他们都保留了建模、调试和拆题能力。',
  },
];

const TIP_CATEGORY_WEIGHTS = {
  '计算机历史': 2,
  '算法思想': 2,
  '语法提醒': 8,
  '信奥人物': 1,
};

function pickRandomTip(previousKey = '') {
  const candidates = TIP_LIBRARY.filter((item) => item.key !== previousKey);
  const source = candidates.length ? candidates : TIP_LIBRARY;
  const weighted = source.map((item) => ({
    item,
    weight: Math.max(1, Number(TIP_CATEGORY_WEIGHTS[item.category] || 1)),
  }));
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = Math.random() * totalWeight;
  let selected = weighted[0] ? weighted[0].item : TIP_LIBRARY[0];
  weighted.forEach((entry) => {
    if (cursor <= 0) {
      return;
    }
    cursor -= entry.weight;
    if (cursor <= 0) {
      selected = entry.item;
    }
  });
  return {
    ...selected,
    badge: `${selected.category} · ${selected.title}`,
  };
}

module.exports = {
  TIP_LIBRARY,
  pickRandomTip,
};
