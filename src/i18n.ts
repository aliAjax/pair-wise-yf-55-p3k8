import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

i18n.use(initReactI18next).init({
  lng: 'zh',
  resources: { zh: { translation: { title: '动态表单协作发布与版本迁移模拟器', publish: '发布', simulate: '迁移模拟', runtime: '运行态表单' } } }
});

export default i18n;
