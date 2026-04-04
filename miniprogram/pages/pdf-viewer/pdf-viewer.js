Page({
  data: {
    viewerUrl: '',
    errorText: '',
  },

  onLoad(options = {}) {
    const app = getApp();
    const baseUrl = String(app && app.globalData && app.globalData.pdfViewerBaseUrl || '').trim();
    const fileUrl = decodeURIComponent(String(options.file || '').trim());
    const fileName = decodeURIComponent(String(options.name || '作业.pdf').trim() || '作业.pdf');

    if (!baseUrl) {
      this.setData({ errorText: '未配置 PDF 预览页地址' });
      return;
    }
    if (!/^https:\/\//.test(baseUrl)) {
      this.setData({ errorText: 'PDF 预览页必须使用 HTTPS 地址' });
      return;
    }
    if (!fileUrl) {
      this.setData({ errorText: '缺少 PDF 文件地址' });
      return;
    }

    const connector = baseUrl.includes('?') ? '&' : '?';
    const viewerUrl = `${baseUrl}${connector}file=${encodeURIComponent(fileUrl)}&name=${encodeURIComponent(fileName)}`;
    this.setData({ viewerUrl, errorText: '' });
  },
});
