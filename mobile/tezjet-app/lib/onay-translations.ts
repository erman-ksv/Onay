export type OnayLanguage = "ru" | "kk" | "uz";
export const ONAY_LANGUAGES = [{ code: "kk", name: "Қазақша" }, { code: "ru", name: "Русский" }, { code: "uz", name: "O‘zbekcha" }] as const;
const messages: Record<string, readonly [string, string]> = {
  "Статус недоступен": ["Мәртебе қолжетімсіз", "Holat mavjud emas"],
  "Язык": ["Тіл","Til"],
  "Телефон не указан": ["Телефон көрсетілмеген","Telefon ko‘rsatilmagan"],
  "Звук и вибрация": ["Дыбыс және діріл","Ovoz va tebranish"],
  "Пока недоступно": ["Әзірге қолжетімсіз","Hozircha mavjud emas"],
  "Документ не опубликован": ["Құжат жарияланбаған","Hujjat eʼlon qilinmagan"],
  "Политика конфиденциальности": ["Құпиялылық саясаты","Maxfiylik siyosati"],
  "Условия использования": ["Пайдалану шарттары","Foydalanish shartlari"],
  "Скопировать email": ["Email мекенжайын көшіру","Email manzilini nusxalash"],
  "Email скопирован": ["Email көшірілді","Email nusxalandi"],
  "Не удалось скопировать email": ["Email-ды көшіру мүмкін болмады","Emailni nusxalab bo‘lmadi"],
  "В деморежиме сообщения не отправляются.": ["Демода хабарламалар жіберілмейді.","Demo rejimida xabarlar yuborilmaydi."],
  "Принимать заказы": ["Тапсырыстарды қабылдау","Buyurtmalarni qabul qilish"],
  "Проверка водителя": ["Жүргізушіні тексеру","Haydovchini tekshirish"],
  "Ваш маршрут": ["Сіздің бағытыңыз","Sizning yo‘nalishingiz"],
  "Главная": [
    "Басты бет",
    "Bosh sahifa"
  ],
  "Поездки": [
    "Сапарлар",
    "Safarlar"
  ],
  "Чаты": [
    "Чаттар",
    "Chatlar"
  ],
  "Профиль": [
    "Профиль",
    "Profil"
  ],
  "История": [
    "Тарих",
    "Tarix"
  ],
  "История поездок": [
    "Сапарлар тарихы",
    "Safarlar tarixi"
  ],
  "Назад": [
    "Артқа",
    "Orqaga"
  ],
  "Язык приложения": [
    "Қолданба тілі",
    "Ilova tili"
  ],
  "Русский": [
    "Русский",
    "Русский"
  ],
  "Қазақша": [
    "Қазақша",
    "Қазақша"
  ],
  "O‘zbekcha": [
    "O‘zbekcha",
    "O‘zbekcha"
  ],
  "Личные данные": [
    "Жеке деректер",
    "Shaxsiy maʼlumotlar"
  ],
  "Режим водителя": [
    "Жүргізуші режимі",
    "Haydovchi rejimi"
  ],
  "Поддержка": [
    "Қолдау",
    "Yordam"
  ],
  "О приложении": [
    "Қолданба туралы",
    "Ilova haqida"
  ],
  "Выйти": [
    "Шығу",
    "Chiqish"
  ],
  "Пассажир": [
    "Жолаушы",
    "Yo‘lovchi"
  ],
  "Водитель": [
    "Жүргізуші",
    "Haydovchi"
  ],
  "Аккаунт пассажира": [
    "Жолаушы аккаунты",
    "Yo‘lovchi hisobi"
  ],
  "Пассажир Onay": [
    "Onay жолаушысы",
    "Onay yo‘lovchisi"
  ],
  "Демо-пассажир": [
    "Демо-жолаушы",
    "Demo yo‘lovchi"
  ],
  "Демо-водитель": [
    "Демо-жүргізуші",
    "Demo haydovchi"
  ],
  "ДЕМО ONAY": [
    "ONAY ДЕМО",
    "ONAY DEMO"
  ],
  "Выйти из демо": [
    "Демодан шығу",
    "Demodan chiqish"
  ],
  "Без сервера · Учебные данные · Без настоящих заказов": [
    "Серверсіз · Оқу деректері · Нақты тапсырыс жоқ",
    "Serversiz · Namuna maʼlumotlar · Haqiqiy buyurtmalar yo‘q"
  ],
  "Точка отправления": [
    "Жөнелу орны",
    "Jo‘nash joyi"
  ],
  "Выбрать остановку": [
    "Аялдаманы таңдау",
    "Bekatni tanlash"
  ],
  "У вас есть активная поездка": [
    "Белсенді сапарыңыз бар",
    "Sizda faol safar bor"
  ],
  "Посмотреть детали ›": [
    "Толығырақ ›",
    "Batafsil ›"
  ],
  "Куда поедем?": [
    "Қайда барамыз?",
    "Qayerga boramiz?"
  ],
  "В город": [
    "Қалаға",
    "Shaharga"
  ],
  "Из села в город": [
    "Ауылдан қалаға",
    "Qishloqdan shaharga"
  ],
  "В село": [
    "Ауылға",
    "Qishloqqa"
  ],
  "Из города домой": [
    "Қаладан үйге",
    "Shahardan uyga"
  ],
  "По своему адресу": [
    "Өз мекенжайыма",
    "O‘z manzilimga"
  ],
  "Уточнение подачи на маршруте C/D": [
    "C/D бағытында келу орнын нақтылау",
    "C/D yo‘nalishida kelish joyini aniqlash"
  ],
  "СХЕМА": [
    "СЫЗБА",
    "CHIZMA"
  ],
  "Не GPS · данные и наличие водителей — в форме заказа": [
    "GPS емес · деректер мен жүргізушілер тапсырыс нысанында",
    "GPS emas · maʼlumotlar va haydovchilar buyurtma shaklida"
  ],
  "Активных поездок нет": [
    "Белсенді сапарлар жоқ",
    "Faol safarlar yo‘q"
  ],
  "Здесь появится текущая поездка после подтверждения заказа.": [
    "Тапсырыс расталғаннан кейін ағымдағы сапар осында көрсетіледі.",
    "Buyurtma tasdiqlangach, joriy safar shu yerda ko‘rinadi."
  ],
  "Выбрать маршрут": [
    "Бағытты таңдау",
    "Yo‘nalishni tanlash"
  ],
  "Линия": [
    "Желі",
    "Liniya"
  ],
  "Очередь": [
    "Кезек",
    "Navbat"
  ],
  "На линии": [
    "Желіде",
    "Liniyada"
  ],
  "ФИО": [
    "Аты-жөні",
    "F.I.Sh."
  ],
  "Номер телефона": [
    "Телефон нөмірі",
    "Telefon raqami"
  ],
  "Режим аккаунта": [
    "Аккаунт режимі",
    "Hisob rejimi"
  ],
  "Не указано": [
    "Көрсетілмеген",
    "Ko‘rsatilmagan"
  ],
  "Данные сохранены при регистрации. Если их нужно изменить, обратитесь в поддержку.": [
    "Деректер тіркелу кезінде сақталған. Өзгерту үшін қолдауға хабарласыңыз.",
    "Maʼlumotlar ro‘yxatdan o‘tishda saqlangan. O‘zgartirish uchun yordamga murojaat qiling."
  ],
  "Способ оплаты": [
    "Төлем тәсілі",
    "To‘lov usuli"
  ],
  "Наличными": [
    "Қолма-қол",
    "Naqd pul"
  ],
  "Режим света": [
    "Түс режимі",
    "Rang rejimi"
  ],
  "Светлая тема": [
    "Ашық тақырып",
    "Yorug‘ mavzu"
  ],
  "Тёмная тема": [
    "Қараңғы тақырып",
    "Qorong‘i mavzu"
  ],
  "Телефон": [
    "Телефон",
    "Telefon"
  ],
  "Войти по номеру телефона": [
    "Телефон нөмірімен кіру",
    "Telefon raqami orqali kirish"
  ],
  "Получить код": [
    "Кодты алу",
    "Kodni olish"
  ],
  "Посмотреть без SMS": [
    "SMS-сіз көру",
    "SMSsiz ko‘rish"
  ],
  "Демо · Без сервера и настоящих заказов": [
    "Демо · Серверсіз және нақты тапсырыссыз",
    "Demo · Serversiz va haqiqiy buyurtmalarsiz"
  ],
  "Нет аккаунта? Регистрация": [
    "Аккаунт жоқ па? Тіркелу",
    "Hisobingiz yo‘qmi? Ro‘yxatdan o‘tish"
  ],
  "Настройки сервера": [
    "Сервер баптаулары",
    "Server sozlamalari"
  ],
  "Код отправляется через настроенный SMS-сервис": [
    "Код бапталған SMS қызметі арқылы жіберіледі",
    "Kod sozlangan SMS xizmati orqali yuboriladi"
  ],
  "Сельское такси между селом и городом": [
    "Ауыл мен қала арасындағы такси",
    "Qishloq va shahar orasidagi taksi"
  ],
  "Я принимаю условия использования и политику конфиденциальности": [
    "Пайдалану шарттары мен құпиялылық саясатын қабылдаймын",
    "Foydalanish shartlari va maxfiylik siyosatiga roziman"
  ],
  "Войти": [
    "Кіру",
    "Kirish"
  ],
  "Регистрация": [
    "Тіркелу",
    "Ro‘yxatdan o‘tish"
  ],
  "Имя": [
    "Аты",
    "Ism"
  ],
  "Фамилия": [
    "Тегі",
    "Familiya"
  ],
  "Код из SMS": [
    "SMS коды",
    "SMS kodi"
  ],
  "Подтвердить": [
    "Растау",
    "Tasdiqlash"
  ],
  "Отправить код повторно": [
    "Кодты қайта жіберу",
    "Kodni qayta yuborish"
  ],
  "Изменить номер": [
    "Нөмірді өзгерту",
    "Raqamni o‘zgartirish"
  ],
  "Автомобиль": [
    "Көлік",
    "Avtomobil"
  ],
  "Маршрут и направление": [
    "Бағыт және қозғалыс",
    "Yo‘nalish va harakat"
  ],
  "Учебный заказ": [
    "Оқу тапсырысы",
    "Sinov buyurtmasi"
  ],
  "Отменить учебную поездку": [
    "Оқу сапарынан бас тарту",
    "Sinov safarini bekor qilish"
  ],
  "Ждём ответа водителя": [
    "Жүргізушінің жауабын күтудеміз",
    "Haydovchi javobini kutmoqdamiz"
  ],
  "Водитель назначен": [
    "Жүргізуші тағайындалды",
    "Haydovchi tayinlandi"
  ],
  "Водитель принял заказ": [
    "Жүргізуші тапсырысты қабылдады",
    "Haydovchi buyurtmani qabul qildi"
  ],
  "Водитель прибыл": [
    "Жүргізуші келді",
    "Haydovchi yetib keldi"
  ],
  "В пути": [
    "Жолда",
    "Yo‘lda"
  ],
  "Поездка завершена": [
    "Сапар аяқталды",
    "Safar tugadi"
  ],
  "Заказ отменён": [
    "Тапсырыс тоқтатылды",
    "Buyurtma bekor qilindi"
  ],
  "Заказ отклонён": [
    "Тапсырыс қабылданбады",
    "Buyurtma rad etildi"
  ],
  "Отменить заказ": [
    "Тапсырыстан бас тарту",
    "Buyurtmani bekor qilish"
  ],
  "Завершить поездку": [
    "Сапарды аяқтау",
    "Safarni tugatish"
  ],
  "Принять": [
    "Қабылдау",
    "Qabul qilish"
  ],
  "Отклонить": [
    "Қабылдамау",
    "Rad etish"
  ],
  "Сохранить": [
    "Сақтау",
    "Saqlash"
  ],
  "Отмена": [
    "Бас тарту",
    "Bekor qilish"
  ],
  "Закрыть": [
    "Жабу",
    "Yopish"
  ],
  "Обновить": [
    "Жаңарту",
    "Yangilash"
  ],
  "Маршрут": [
    "Бағыт",
    "Yo‘nalish"
  ],
  "Откуда": [
    "Қайдан",
    "Qayerdan"
  ],
  "Куда": [
    "Қайда",
    "Qayerga"
  ],
  "Места": [
    "Орындар",
    "O‘rinlar"
  ],
  "Пассажиров": [
    "Жолаушылар",
    "Yo‘lovchilar"
  ],
  "Сумма": [
    "Сома",
    "Summa"
  ],
  "Детали поездки": [
    "Сапар мәліметтері",
    "Safar tafsilotlari"
  ],
  "Заказать": [
    "Тапсырыс беру",
    "Buyurtma berish"
  ],
  "Сообщений пока нет": [
    "Әзірге хабарламалар жоқ",
    "Hozircha xabarlar yo‘q"
  ],
  "Нет завершённых поездок": [
    "Аяқталған сапарлар жоқ",
    "Tugallangan safarlar yo‘q"
  ],
  "Назад в профиль": [
    "Профильге оралу",
    "Profilga qaytish"
  ],
  "Демо · Оформление": [
    "Демо · Тапсырыс",
    "Demo · Buyurtma"
  ],
  "Демо · Маршрут": [
    "Демо · Бағыт",
    "Demo · Yo‘nalish"
  ],
  "Демо · Автомобиль": [
    "Демо · Көлік",
    "Demo · Avtomobil"
  ],
  "Демо · Поддержка": [
    "Демо · Қолдау",
    "Demo · Yordam"
  ],
  "Демо · Сервер": [
    "Демо · Сервер",
    "Demo · Server"
  ],
  "Не удалось получить историю. Проверь соединение и повтори обновление.": [
    "Тарихты алу мүмкін болмады. Байланысты тексеріп, қайта жаңартыңыз.",
    "Tarixni olib bo‘lmadi. Ulanishni tekshirib, qayta yangilang."
  ],
  "Загружаем историю…": [
    "Тарих жүктелуде…",
    "Tarix yuklanmoqda…"
  ],
  "Завершённые поездки": [
    "Аяқталған сапарлар",
    "Tugallangan safarlar"
  ],
  "Стоимость недоступна": [
    "Құны қолжетімсіз",
    "Narx mavjud emas"
  ],
  "Нет завершённых поездок с заработком": [
    "Табысы бар аяқталған сапарлар жоқ",
    "Daromadli tugallangan safarlar yo‘q"
  ],
  "Завершено поездок:": [
    "Аяқталған сапарлар:",
    "Tugallangan safarlar:"
  ],
  "Сумма тарифов завершённых поездок — без подтверждения оплаты и вычета расходов.": [
    "Аяқталған сапарлар тарифтерінің сомасы — төлемді растаусыз және шығындарды шегерусіз.",
    "Tugallangan safarlar tariflari yig‘indisi — to‘lov tasdiqlanmagan va xarajatlar ayrilmagan."
  ],
  "Поездок пока нет": [
    "Әзірге сапарлар жоқ",
    "Hozircha safarlar yo‘q"
  ],
  "Здесь появятся завершённые поездки": [
    "Аяқталған сапарлар осында көрсетіледі",
    "Tugallangan safarlar shu yerda ko‘rinadi"
  ],
  "Показать ещё": [
    "Тағы көрсету",
    "Yana ko‘rsatish"
  ],
  "Обновляем…": [
    "Жаңартылуда…",
    "Yangilanmoqda…"
  ],
  "Обновить историю": [
    "Тарихты жаңарту",
    "Tarixni yangilash"
  ],
  "История и заработок": [
    "Тарих және табыс",
    "Tarix va daromad"
  ],
  "Скрыть историю": [
    "Тарихты жасыру",
    "Tarixni yashirish"
  ],
  "Показать историю": [
    "Тарихты көрсету",
    "Tarixni ko‘rsatish"
  ],
  "Все закрытые поездки этого водителя. Сумма тарифов завершённых поездок — без подтверждения оплаты и вычета расходов.": [
    "Осы жүргізушінің барлық жабылған сапарлары. Аяқталған сапарлар тарифтерінің сомасы — төлемді растаусыз және шығындарды шегерусіз.",
    "Bu haydovchining barcha yopilgan safarlari. Tugallangan safarlar tariflari yig‘indisi — to‘lov tasdiqlanmagan va xarajatlar ayrilmagan."
  ],
  "Сумма недоступна: у части завершённых поездок нет достоверной стоимости.": [
    "Сома қолжетімсіз: кейбір аяқталған сапарлардың нақты құны жоқ.",
    "Summa mavjud emas: ayrim tugallangan safarlarning ishonchli narxi yo‘q."
  ],
  "Завершённых поездок с заработком пока нет.": [
    "Әзірге табысы бар аяқталған сапарлар жоқ.",
    "Hozircha daromadli tugallangan safarlar yo‘q."
  ],
  "Завершённые и отменённые поездки появятся здесь после обновления истории.": [
    "Тарих жаңартылғаннан кейін аяқталған және тоқтатылған сапарлар осында көрсетіледі.",
    "Tarix yangilangach, tugallangan va bekor qilingan safarlar shu yerda ko‘rinadi."
  ],
  "мест": [
    "орын",
    "o‘rin"
  ],
  "· не входит в заработок": [
    "· табысқа кірмейді",
    "· daromadga kirmaydi"
  ],
  "Заказ": [
    "Тапсырыс",
    "Buyurtma"
  ],
  "Обновлено:": [
    "Жаңартылды:",
    "Yangilandi:"
  ],
  "дата недоступна": [
    "күні қолжетімсіз",
    "sana mavjud emas"
  ],
  "Сохранённый маршрут удалён.": [
    "Сақталған бағыт жойылған.",
    "Saqlangan yo‘nalish o‘chirilgan."
  ],
  "Сохранённый маршрут отключён.": [
    "Сақталған бағыт өшірілген.",
    "Saqlangan yo‘nalish o‘chirilgan."
  ],
  "Сохранённый маршрут изменился.": [
    "Сақталған бағыт өзгерген.",
    "Saqlangan yo‘nalish o‘zgargan."
  ],
  "Сохранённый маршрут пока не настроен.": [
    "Сақталған бағыт әлі бапталмаған.",
    "Saqlangan yo‘nalish hali sozlanmagan."
  ],
  "Не удалось загрузить маршруты. Повтори обновление.": [
    "Бағыттарды жүктеу мүмкін болмады. Қайта жаңартыңыз.",
    "Yo‘nalishlarni yuklab bo‘lmadi. Qayta yangilang."
  ],
  "Выбор маршрута сброшен.": [
    "Бағыт таңдауы қалпына келтірілді.",
    "Yo‘nalish tanlovi bekor qilindi."
  ],
  "Маршрут и направление сохранены.": [
    "Бағыт және қозғалыс сақталды.",
    "Yo‘nalish va harakat saqlandi."
  ],
  "Маршрут изменился. Проверь обновлённые остановки и сохрани выбор ещё раз.": [
    "Бағыт өзгерген. Жаңартылған аялдамаларды тексеріп, таңдауды қайта сақтаңыз.",
    "Yo‘nalish o‘zgargan. Yangilangan bekatlarni tekshirib, tanlovni qayta saqlang."
  ],
  "Маршрут больше недоступен. Выбери другой маршрут или сбрось сохранённый выбор.": [
    "Бағыт енді қолжетімсіз. Басқа бағытты таңдаңыз немесе сақталған таңдауды тазалаңыз.",
    "Yo‘nalish endi mavjud emas. Boshqa yo‘nalishni tanlang yoki saqlangan tanlovni tozalang."
  ],
  "Сначала выйди из очереди, ответь на предложение и заверши текущую поездку.": [
    "Алдымен кезектен шығып, ұсынысқа жауап беріп, ағымдағы сапарды аяқтаңыз.",
    "Avval navbatdan chiqing, taklifga javob bering va joriy safarni tugating."
  ],
  "Не удалось сохранить выбор маршрута.": [
    "Бағыт таңдауын сақтау мүмкін болмады.",
    "Yo‘nalish tanlovini saqlab bo‘lmadi."
  ],
  "Маршрут водителя": [
    "Жүргізуші бағыты",
    "Haydovchi yo‘nalishi"
  ],
  "Выбери маршрут и направление, затем сохрани выбор.": [
    "Бағыт пен қозғалысты таңдап, таңдауды сақтаңыз.",
    "Yo‘nalish va harakatni tanlab, tanlovni saqlang."
  ],
  "Загружаем маршруты и сохранённый выбор…": [
    "Бағыттар мен сақталған таңдау жүктелуде…",
    "Yo‘nalishlar va saqlangan tanlov yuklanmoqda…"
  ],
  "Сохранено:": [
    "Сақталған:",
    "Saqlandi:"
  ],
  "Выбери маршрут заново или сбрось выбор.": [
    "Бағытты қайта таңдаңыз немесе таңдауды тазалаңыз.",
    "Yo‘nalishni qayta tanlang yoki tanlovni tozalang."
  ],
  "Очередь: питак": [
    "Кезек: тұрақ",
    "Navbat: pitak"
  ],
  ". Для входа нужно находиться рядом с ним.": [
    ". Кезекке кіру үшін жанында болу керек.",
    ". Kirish uchun uning yaqinida bo‘lish kerak."
  ],
  "Маршрут не выбран. Можно использовать общую очередь.": [
    "Бағыт таңдалмаған. Жалпы кезекті пайдалануға болады.",
    "Yo‘nalish tanlanmagan. Umumiy navbatdan foydalanish mumkin."
  ],
  "Обнови маршруты, чтобы проверить сохранённый выбор.": [
    "Сақталған таңдауды тексеру үшін бағыттарды жаңартыңыз.",
    "Saqlangan tanlovni tekshirish uchun yo‘nalishlarni yangilang."
  ],
  "Нет доступных настроенных маршрутов. Повтори обновление позже.": [
    "Бапталған қолжетімді бағыттар жоқ. Кейінірек қайта жаңартыңыз.",
    "Sozlangan yo‘nalishlar mavjud emas. Keyinroq qayta yangilang."
  ],
  "Маршрут черновика больше недоступен. Выбери другой маршрут.": [
    "Жобадағы бағыт енді қолжетімсіз. Басқа бағытты таңдаңыз.",
    "Qoralamadagi yo‘nalish endi mavjud emas. Boshqa yo‘nalishni tanlang."
  ],
  "НАПРАВЛЕНИЕ": [
    "БАҒЫТ",
    "YO‘NALISH"
  ],
  "ОСТАНОВКИ ПО НАПРАВЛЕНИЮ": [
    "БАҒЫТ БОЙЫНША АЯЛДАМАЛАР",
    "YO‘NALISH BO‘YICHA BEKATLAR"
  ],
  "Выбор в списке — черновик до сохранения.": [
    "Тізімдегі таңдау сақталғанға дейін жоба болып саналады.",
    "Ro‘yxatdagi tanlov saqlanguncha qoralama hisoblanadi."
  ],
  "Менять маршрут можно после выхода из очереди, ответа на предложение и завершения поездки.": [
    "Бағытты кезектен шыққаннан, ұсынысқа жауап бергеннен және сапарды аяқтағаннан кейін өзгертуге болады.",
    "Yo‘nalishni navbatdan chiqqach, taklifga javob bergach va safarni tugatgach o‘zgartirish mumkin."
  ],
  "Сохраняем…": [
    "Сақталуда…",
    "Saqlanmoqda…"
  ],
  "Сохранить маршрут": [
    "Бағытты сақтау",
    "Yo‘nalishni saqlash"
  ],
  "Сбросить выбор маршрута": [
    "Бағыт таңдауын тазалау",
    "Yo‘nalish tanlovini tozalash"
  ],
  "Обновить маршруты": [
    "Бағыттарды жаңарту",
    "Yo‘nalishlarni yangilash"
  ],
  "Мой автомобиль": [
    "Менің көлігім",
    "Mening avtomobilim"
  ],
  "После изменения нужна повторная проверка администратора.": [
    "Өзгерткеннен кейін әкімшінің қайта тексеруі қажет.",
    "O‘zgartirgandan so‘ng administrator qayta tekshirishi kerak."
  ],
  "Статус водителя:": [
    "Жүргізуші мәртебесі:",
    "Haydovchi holati:"
  ],
  "Подтверждён": [
    "Расталған",
    "Tasdiqlangan"
  ],
  "На проверке": [
    "Тексерілуде",
    "Tekshirilmoqda"
  ],
  "Отклонён": [
    "Қабылданбаған",
    "Rad etilgan"
  ],
  "Заблокирован": [
    "Бұғатталған",
    "Bloklangan"
  ],
  "Работа водителем заблокирована администратором.": [
    "Жүргізуші жұмысы әкімші тарапынан бұғатталған.",
    "Haydovchilik faoliyati administrator tomonidan bloklangan."
  ],
  "Загружаем автомобиль…": [
    "Көлік жүктелуде…",
    "Avtomobil yuklanmoqda…"
  ],
  "Марка автомобиля": [
    "Көлік маркасы",
    "Avtomobil markasi"
  ],
  "Модель автомобиля": [
    "Көлік үлгісі",
    "Avtomobil modeli"
  ],
  "Госномер": [
    "Мемлекеттік нөмір",
    "Davlat raqami"
  ],
  "Пассажирских мест, без водителя: 1–8": [
    "Жолаушы орны, жүргізушісіз: 1–8",
    "Yo‘lovchi o‘rinlari, haydovchisiz: 1–8"
  ],
  "Пассажирских мест": [
    "Жолаушы орындары",
    "Yo‘lovchi o‘rinlari"
  ],
  "Изменение доступно после завершения поездок и выхода из очереди.": [
    "Сапарлар аяқталып, кезектен шыққаннан кейін өзгертуге болады.",
    "Safarlar tugagach va navbatdan chiqqach o‘zgartirish mumkin."
  ],
  "Сохранить автомобиль": [
    "Көлікті сақтау",
    "Avtomobilni saqlash"
  ],
  "Обновить автомобиль": [
    "Көлікті жаңарту",
    "Avtomobilni yangilash"
  ],
  "Вход в Onay": [
    "Onay-ға кіру",
    "Onayga kirish"
  ],
  "Изменить номер телефона": [
    "Телефон нөмірін өзгерту",
    "Telefon raqamini o‘zgartirish"
  ],
  "Введите код": [
    "Кодты енгізіңіз",
    "Kodni kiriting"
  ],
  "Регистрация водителя": [
    "Жүргізушіні тіркеу",
    "Haydovchini ro‘yxatdan o‘tkazish"
  ],
  "Регистрация пассажира": [
    "Жолаушыны тіркеу",
    "Yo‘lovchini ro‘yxatdan o‘tkazish"
  ],
  "Код подтверждения отправляется на": [
    "Растау коды жіберіледі:",
    "Tasdiqlash kodi yuboriladi:"
  ],
  "Код подтверждения": [
    "Растау коды",
    "Tasdiqlash kodi"
  ],
  "Тестовый код:": [
    "Сынақ коды:",
    "Sinov kodi:"
  ],
  "Демо-код доступен только в тестовой среде": [
    "Демо код тек сынақ ортасында қолжетімді",
    "Demo kod faqat sinov muhitida mavjud"
  ],
  "Профиль водителя требует одобрения администратора": [
    "Жүргізуші профилі әкімші мақұлдауын қажет етеді",
    "Haydovchi profili administrator tasdig‘ini talab qiladi"
  ],
  "Уже зарегистрирован? Войти": [
    "Тіркелгенсіз бе? Кіру",
    "Ro‘yxatdan o‘tganmisiz? Kirish"
  ],
  "ДЕМО · Без SMS и сервера. Все данные учебные. Настоящие заказы не отправляются.": [
    "ДЕМО · SMS-сіз және серверсіз. Барлық дерек оқу үшін. Нақты тапсырыстар жіберілмейді.",
    "DEMO · SMSsiz va serversiz. Barcha maʼlumotlar namuna. Haqiqiy buyurtmalar yuborilmaydi."
  ],
  "Звонки и сообщения в демо не отправляются.": [
    "Демода қоңырау мен хабарлама жіберілмейді.",
    "Demoda qo‘ng‘iroq va xabarlar yuborilmaydi."
  ],
  "Демо-автомобиль · мест:": [
    "Демо-көлік · орын:",
    "Demo avtomobil · o‘rinlar:"
  ],
  "Демо-пассажир ·": [
    "Демо-жолаушы ·",
    "Demo yo‘lovchi ·"
  ],
  "мест ·": [
    "орын ·",
    "o‘rin ·"
  ],
  "Принять (демо)": [
    "Қабылдау (демо)",
    "Qabul qilish (demo)"
  ],
  "Прибыл (демо)": [
    "Келдім (демо)",
    "Yetib keldim (demo)"
  ],
  "Пассажир сел (демо)": [
    "Жолаушы отырды (демо)",
    "Yo‘lovchi o‘tirdi (demo)"
  ],
  "Начать поездку (демо)": [
    "Сапарды бастау (демо)",
    "Safarni boshlash (demo)"
  ],
  "Завершить (демо)": [
    "Аяқтау (демо)",
    "Tugatish (demo)"
  ],
  "Отменить учебный заказ": [
    "Оқу тапсырысын тоқтату",
    "Sinov buyurtmasini bekor qilish"
  ],
  "Показать пример заказа": [
    "Тапсырыс үлгісін көрсету",
    "Buyurtma namunasini ko‘rsatish"
  ],
  "Выбрать учебный маршрут": [
    "Оқу бағытын таңдау",
    "Sinov yo‘nalishini tanlash"
  ],
  "1 · Демо-водитель": [
    "1 · Демо-жүргізуші",
    "1 · Demo haydovchi"
  ],
  "Пример очереди. К реальной очереди не подключено.": [
    "Кезек үлгісі. Нақты кезекке қосылмаған.",
    "Navbat namunasi. Haqiqiy navbatga ulanmagan."
  ],
  "Учебных свободных мест:": [
    "Оқу үлгісіндегі бос орындар:",
    "Sinovdagi bo‘sh o‘rinlar:"
  ],
  "ДЕМО ·": [
    "ДЕМО ·",
    "DEMO ·"
  ],
  "Пассажиры": [
    "Жолаушылар",
    "Yo‘lovchilar"
  ],
  "Пример тарифа:": [
    "Тариф үлгісі:",
    "Tarif namunasi:"
  ],
  ". Это не предложение реальной поездки.": [
    ". Бұл нақты сапар ұсынысы емес.",
    ". Bu haqiqiy safar taklifi emas."
  ],
  "Открыть учебную поездку": [
    "Оқу сапарын ашу",
    "Sinov safarini ochish"
  ],
  "Показать учебную поездку": [
    "Оқу сапарын көрсету",
    "Sinov safarini ko‘rsatish"
  ],
  "Учебный номер": [
    "Оқу нөмірі",
    "Sinov raqami"
  ],
  "Мест в салоне:": [
    "Салондағы орын:",
    "Salondagi o‘rinlar:"
  ],
  "Вернуться к демо": [
    "Демоға оралу",
    "Demoga qaytish"
  ],
  "Изменения только для демонстрации; после выхода они исчезнут.": [
    "Өзгерістер тек көрсету үшін; шыққаннан кейін жойылады.",
    "O‘zgarishlar faqat namoyish uchun; chiqqach yo‘qoladi."
  ],
  "Демо работает без подключения. Для настоящего входа выйдите из демо и откройте настройки сервера на экране авторизации.": [
    "Демо қосылусыз жұмыс істейді. Нақты кіру үшін демодан шығып, кіру экранында сервер баптауларын ашыңыз.",
    "Demo ulanmasdan ishlaydi. Haqiqiy kirish uchun demodan chiqing va kirish ekranida server sozlamalarini oching."
  ],
  "В деморежиме сообщения не отправляются. Здесь можно только посмотреть интерфейс.": [
    "Демода хабарламалар жіберілмейді. Мұнда тек интерфейсті көруге болады.",
    "Demoda xabarlar yuborilmaydi. Bu yerda faqat interfeysni ko‘rish mumkin."
  ],
  "Режим пассажира": [
    "Жолаушы режимі",
    "Yo‘lovchi rejimi"
  ],
  "Добавить": [
    "Қосу",
    "Qo‘shish"
  ],
  "Номер": [
    "Нөмір",
    "Raqam"
  ],
  "Не указан": [
    "Көрсетілмеген",
    "Ko‘rsatilmagan"
  ],
  "Мест в салоне": [
    "Салондағы орындар",
    "Salondagi o‘rinlar"
  ],
  "Анкета": [
    "Сауалнама",
    "Anketa"
  ],
  "Подтверждена": [
    "Расталған",
    "Tasdiqlangan"
  ],
  "Заблокирована": [
    "Бұғатталған",
    "Bloklangan"
  ],
  "Отклонена": [
    "Қабылданбаған",
    "Rad etilgan"
  ],
  "Выйти из аккаунта": [
    "Аккаунттан шығу",
    "Hisobdan chiqish"
  ],
  "Onay Driver · Версия": [
    "Onay Driver · Нұсқа",
    "Onay Driver · Versiya"
  ],
  "Не удалось обновить очередь.": [
    "Кезекті жаңарту мүмкін болмады.",
    "Navbatni yangilab bo‘lmadi."
  ],
  "Нет актуальных данных очереди. Повтори обновление.": [
    "Кезектің өзекті деректері жоқ. Қайта жаңартыңыз.",
    "Navbatning dolzarb maʼlumoti yo‘q. Qayta yangilang."
  ],
  "В этой очереди пока нет водителей.": [
    "Бұл кезекте әзірге жүргізушілер жоқ.",
    "Bu navbatda hozircha haydovchilar yo‘q."
  ],
  "Вы": [
    "Сіз",
    "Siz"
  ],
  "Свободных мест:": [
    "Бос орындар:",
    "Bo‘sh o‘rinlar:"
  ],
  "Показано 100 из": [
    "100 көрсетілді, барлығы",
    "100 ta ko‘rsatildi, jami"
  ],
  "Обновить очередь": [
    "Кезекті жаңарту",
    "Navbatni yangilash"
  ],
  "Логотип Onay": [
    "Onay логотипі",
    "Onay logotipi"
  ],
  "Пассажиров:": [
    "Жолаушылар:",
    "Yo‘lovchilar:"
  ],
  "Не входит в заработок": [
    "Табысқа кірмейді",
    "Daromadga kirmaydi"
  ],
  "Поездка": [
    "Сапар",
    "Safar"
  ],
  "Статус": [
    "Мәртебе",
    "Holat"
  ],
  "Дата заказа": [
    "Тапсырыс күні",
    "Buyurtma sanasi"
  ],
  "Стоимость поездки": [
    "Сапар құны",
    "Safar narxi"
  ],
  "Тестовая сборка": [
    "Сынақ жинағы",
    "Sinov yig‘ilmasi"
  ],
  "Версия": [
    "Нұсқа",
    "Versiya"
  ],
  "Междугородние поездки на такси. Выберите маршрут и остановку, затем оформите заказ. Стоимость и доступность водителей подтверждаются сервером.": [
    "Қалааралық такси сапарлары. Бағыт пен аялдаманы таңдап, тапсырыс беріңіз. Құны мен жүргізушілердің қолжетімділігі сервермен расталады.",
    "Shaharlararo taksi safarlari. Yo‘nalish va bekatni tanlab, buyurtma bering. Narx va haydovchilar mavjudligi server orqali tasdiqlanadi."
  ],
  "Чатов пока нет": [
    "Әзірге чаттар жоқ",
    "Hozircha chatlar yo‘q"
  ],
  "Переписка с водителем пока недоступна. Когда функция будет подключена, чаты появятся здесь.": [
    "Жүргізушімен хат алмасу әлі қолжетімсіз. Мүмкіндік қосылғанда, чаттар осында көрсетіледі.",
    "Haydovchi bilan yozishma hali mavjud emas. Funksiya yoqilgach, chatlar shu yerda ko‘rinadi."
  ],
  "Посмотреть активную поездку": [
    "Белсенді сапарды көру",
    "Faol safarni ko‘rish"
  ],
  "Onay · Версия": [
    "Onay · Нұсқа",
    "Onay · Versiya"
  ],
  "Открыть текущую поездку": [
    "Ағымдағы сапарды ашу",
    "Joriy safarni ochish"
  ],
  "· Пассажиров:": [
    "· Жолаушылар:",
    "· Yo‘lovchilar:"
  ],
  "Проверяем направление, места и доступность": [
    "Бағыт, орындар мен қолжетімділікті тексерудеміз",
    "Yo‘nalish, o‘rinlar va mavjudlik tekshirilmoqda"
  ],
  "Точка подачи:": [
    "Келу орны:",
    "Kelish joyi:"
  ],
  "Куда:": [
    "Қайда:",
    "Qayerga:"
  ],
  "Поддержка Onay": [
    "Onay қолдауы",
    "Onay yordami"
  ],
  "Напишите нам:": [
    "Бізге жазыңыз:",
    "Bizga yozing:"
  ],
  "Поможем с заказом, оплатой или работой приложения. Выберите, как вам удобнее связаться.": [
    "Тапсырыс, төлем немесе қолданба бойынша көмектесеміз. Ыңғайлы байланыс тәсілін таңдаңыз.",
    "Buyurtma, to‘lov yoki ilova bo‘yicha yordam beramiz. Qulay aloqa usulini tanlang."
  ],
  "Написать в поддержку на email": [
    "Қолдауға email жазу",
    "Yordamga email yozish"
  ],
  "Написать на email": [
    "Email жазу",
    "Email yozish"
  ],
  "Чат с поддержкой пока недоступен": [
    "Қолдау чаты әлі қолжетімсіз",
    "Yordam chati hali mavjud emas"
  ],
  "Чат с поддержкой": [
    "Қолдау чаты",
    "Yordam chati"
  ],
  "Пока недоступен": [
    "Әзірге қолжетімсіз",
    "Hozircha mavjud emas"
  ],
  "Точка посадки": [
    "Отыру орны",
    "Chiqish joyi"
  ],
  "Назначение": [
    "Баратын жер",
    "Borish joyi"
  ],
  "Схема маршрута · не GPS": [
    "Бағыт сызбасы · GPS емес",
    "Yo‘nalish chizmasi · GPS emas"
  ],
  "Сервер Onay": [
    "Onay сервері",
    "Onay serveri"
  ],
  "Сохранить сервер": [
    "Серверді сақтау",
    "Serverni saqlash"
  ],
  "Подключаем…": [
    "Қосылуда…",
    "Ulanmoqda…"
  ],
  "Укажи адрес сервера для подключения. При смене сервера потребуется вход по телефону.": [
    "Қосылу үшін сервер мекенжайын көрсетіңіз. Сервер өзгергенде телефонмен кіру қажет.",
    "Ulanish uchun server manzilini kiriting. Server o‘zgarsa, telefon orqali kirish kerak."
  ],
  "Адрес API": [
    "API мекенжайы",
    "API manzili"
  ],
  "Адрес сервера Onay": [
    "Onay серверінің мекенжайы",
    "Onay server manzili"
  ],
  "Сервер не ответил вовремя. Повтори обновление.": [
    "Сервер уақытында жауап бермеді. Қайта жаңартыңыз.",
    "Server vaqtida javob bermadi. Qayta yangilang."
  ],
  "Нет связи с Onay. Повтори обновление.": [
    "Onay байланысы жоқ. Қайта жаңартыңыз.",
    "Onay bilan aloqa yo‘q. Qayta yangilang."
  ],
  "Твой водитель": [
    "Сіздің жүргізушіңіз",
    "Sizning haydovchingiz"
  ],
  "Получаем данные водителя…": [
    "Жүргізуші деректері алынуда…",
    "Haydovchi maʼlumotlari olinmoqda…"
  ],
  "Имя водителя не указано": [
    "Жүргізушінің аты көрсетілмеген",
    "Haydovchi ismi ko‘rsatilmagan"
  ],
  "Не удалось открыть звонок. Набери номер вручную.": [
    "Қоңырауды ашу мүмкін болмады. Нөмірді қолмен теріңіз.",
    "Qo‘ng‘iroqni ochib bo‘lmadi. Raqamni qo‘lda tering."
  ],
  "Позвонить:": [
    "Қоңырау шалу:",
    "Qo‘ng‘iroq qilish:"
  ],
  "Госномер:": [
    "Мемлекеттік нөмір:",
    "Davlat raqami:"
  ],
  "Пассажирских мест:": [
    "Жолаушы орындары:",
    "Yo‘lovchi o‘rinlari:"
  ],
  "Данные автомобиля пока не указаны.": [
    "Көлік деректері әлі көрсетілмеген.",
    "Avtomobil maʼlumotlari hali ko‘rsatilmagan."
  ],
  "Повторить получение данных": [
    "Деректерді қайта алу",
    "Maʼlumotlarni qayta olish"
  ],
  "Закрытых поездок:": [
    "Жабылған сапарлар:",
    "Yopilgan safarlar:"
  ],
  ". Сначала новые.": [
    ". Алдымен жаңалары.",
    ". Avval yangilari."
  ],
  "Здесь появятся завершённые и отменённые поездки": [
    "Аяқталған және тоқтатылған сапарлар осында көрсетіледі",
    "Tugallangan va bekor qilingan safarlar shu yerda ko‘rinadi"
  ],
  "Последние поездки": [
    "Соңғы сапарлар",
    "So‘nggi safarlar"
  ],
  "Скрыть полную историю": [
    "Толық тарихты жасыру",
    "To‘liq tarixni yashirish"
  ],
  "Вся история поездок": [
    "Барлық сапарлар тарихы",
    "Barcha safarlar tarixi"
  ],
  "Дата заказа:": [
    "Тапсырыс күні:",
    "Buyurtma sanasi:"
  ],
  "Стоимость поездки:": [
    "Сапар құны:",
    "Safar narxi:"
  ],
  "недоступна": [
    "қолжетімсіз",
    "mavjud emas"
  ],
  "Покажем водителей, которые едут по выбранному маршруту. Стоимость и свободные места подтвердит сервер.": [
    "Таңдалған бағыттағы жүргізушілерді көрсетеміз. Құны мен бос орындарды сервер растайды.",
    "Tanlangan yo‘nalishdagi haydovchilarni ko‘rsatamiz. Narx va bo‘sh o‘rinlarni server tasdiqlaydi."
  ],
  "Настроенных маршрутов пока нет.": [
    "Әзірге бапталған бағыттар жоқ.",
    "Hozircha sozlangan yo‘nalishlar yo‘q."
  ],
  "Не удалось загрузить маршруты:": [
    "Бағыттарды жүктеу мүмкін болмады:",
    "Yo‘nalishlarni yuklab bo‘lmadi:"
  ],
  "Повторить загрузку маршрутов": [
    "Бағыттарды қайта жүктеу",
    "Yo‘nalishlarni qayta yuklash"
  ],
  "Изменить маршрут и направление": [
    "Бағыт пен қозғалысты өзгерту",
    "Yo‘nalish va harakatni o‘zgartirish"
  ],
  "Маршрут ·": [
    "Бағыт ·",
    "Yo‘nalish ·"
  ],
  "Место посадки:": [
    "Отыру орны:",
    "Chiqish joyi:"
  ],
  "Выберите посадку": [
    "Отыру орнын таңдаңыз",
    "Chiqish joyini tanlang"
  ],
  "Назначение:": [
    "Баратын жер:",
    "Borish joyi:"
  ],
  "Выберите назначение": [
    "Баратын жерді таңдаңыз",
    "Borish joyini tanlang"
  ],
  "ГДЕ САДИТЕСЬ?": [
    "ҚАЙДАН ОТЫРАСЫЗ?",
    "QAYERDAN CHIQASIZ?"
  ],
  "КУДА ЕДЕТЕ?": [
    "ҚАЙДА БАРАСЫЗ?",
    "QAYERGA BORASIZ?"
  ],
  "Посадка должна быть раньше назначения по выбранному направлению.": [
    "Таңдалған бағытта отыру орны баратын жерден бұрын болуы керек.",
    "Tanlangan yo‘nalishda chiqish joyi borish joyidan oldin bo‘lishi kerak."
  ],
  "Места: от 1 до 8": [
    "Орындар: 1-ден 8-ге дейін",
    "O‘rinlar: 1 dan 8 gacha"
  ],
  "Уменьшить количество мест": [
    "Орын санын азайту",
    "O‘rinlar sonini kamaytirish"
  ],
  "Увеличить количество мест": [
    "Орын санын көбейту",
    "O‘rinlar sonini ko‘paytirish"
  ],
  "Когда": [
    "Қашан",
    "Qachon"
  ],
  "Сейчас": [
    "Қазір",
    "Hozir"
  ],
  "Проверяем…": [
    "Тексерілуде…",
    "Tekshirilmoqda…"
  ],
  "Найти водителей": [
    "Жүргізушілерді табу",
    "Haydovchilarni topish"
  ],
  "ПОДТВЕРЖДЁННАЯ СТОИМОСТЬ": [
    "РАСТАЛҒАН ҚҰНЫ",
    "TASDIQLANGAN NARX"
  ],
  "Свободных водителей:": [
    "Бос жүргізушілер:",
    "Bo‘sh haydovchilar:"
  ],
  "Свободных водителей сейчас нет": [
    "Қазір бос жүргізушілер жоқ",
    "Hozir bo‘sh haydovchilar yo‘q"
  ],
  "Обновите наличие и цену перед заказом": [
    "Тапсырыс алдында қолжетімділік пен бағаны жаңартыңыз",
    "Buyurtmadan oldin mavjudlik va narxni yangilang"
  ],
  "Оформляем…": [
    "Рәсімделуде…",
    "Rasmiylashtirilmoqda…"
  ],
  "Заказать поездку": [
    "Сапарға тапсырыс беру",
    "Safarga buyurtma berish"
  ],
  "Проверить статус заказа": [
    "Тапсырыс мәртебесін тексеру",
    "Buyurtma holatini tekshirish"
  ],
  "Сначала заверши или отмени текущую поездку.": [
    "Алдымен ағымдағы сапарды аяқтаңыз немесе тоқтатыңыз.",
    "Avval joriy safarni tugating yoki bekor qiling."
  ],
  "Автомобиль изменился. Обнови профиль и проверь данные перед сохранением.": [
    "Көлік өзгерген. Профильді жаңартып, сақтау алдында деректерді тексеріңіз.",
    "Avtomobil o‘zgargan. Profilni yangilang va saqlashdan oldin maʼlumotlarni tekshiring."
  ],
  "Сначала заверши поездки и выйди из очереди, затем изменяй автомобиль.": [
    "Алдымен сапарларды аяқтап, кезектен шығыңыз, содан кейін көлікті өзгертіңіз.",
    "Avval safarlarni tugatib, navbatdan chiqing, so‘ng avtomobilni o‘zgartiring."
  ],
  "Не удалось сохранить или получить автомобиль. Проверь данные и повтори обновление.": [
    "Көлікті сақтау немесе алу мүмкін болмады. Деректерді тексеріп, қайта жаңартыңыз.",
    "Avtomobilni saqlab yoki olib bo‘lmadi. Maʼlumotlarni tekshirib, qayta yangilang."
  ],
  "Не удалось получить автомобиль. Повтори обновление.": [
    "Көлікті алу мүмкін болмады. Қайта жаңартыңыз.",
    "Avtomobilni olib bo‘lmadi. Qayta yangilang."
  ],
  "Сервер не подтвердил сохранение автомобиля. Повтори обновление.": [
    "Сервер көліктің сақталғанын растамады. Қайта жаңартыңыз.",
    "Server avtomobil saqlanganini tasdiqlamadi. Qayta yangilang."
  ],
  "Автомобиль сохранён. Блокировка водителя остаётся; снять её может только администратор.": [
    "Көлік сақталды. Жүргізуші бұғаттаулы; оны тек әкімші аша алады.",
    "Avtomobil saqlandi. Haydovchi bloklangan; faqat administrator blokdan chiqarishi mumkin."
  ],
  "Автомобиль сохранён и отправлен администратору на проверку.": [
    "Көлік сақталып, әкімшіге тексеруге жіберілді.",
    "Avtomobil saqlandi va tekshirish uchun administratorga yuborildi."
  ],
  "Ответ не получен. Обнови профиль, чтобы проверить результат сохранения.": [
    "Жауап алынбады. Сақтау нәтижесін тексеру үшін профильді жаңартыңыз.",
    "Javob olinmadi. Saqlash natijasini tekshirish uchun profilni yangilang."
  ],
  "ДЕМО · Shaxsham": [
    "ДЕМО · Shaxsham",
    "DEMO · Shaxsham"
  ],
  "ДЕМО · Gazalkent": [
    "ДЕМО · Gazalkent",
    "DEMO · Gazalkent"
  ],
  "Подключение изменилось. Вернись к исходному серверу для проверки заказа.": [
    "Қосылым өзгерді. Тапсырысты тексеру үшін бастапқы серверге оралыңыз.",
    "Ulanish o‘zgardi. Buyurtmani tekshirish uchun dastlabki serverga qayting."
  ],
  "Подключение изменилось. Результат заказа нужно проверить на исходном сервере.": [
    "Қосылым өзгерді. Тапсырыс нәтижесін бастапқы серверде тексеру керек.",
    "Ulanish o‘zgardi. Buyurtma natijasini dastlabki serverda tekshirish kerak."
  ],
  "Сначала подключи сервер и войди в аккаунт. Создание заказа заблокировано.": [
    "Алдымен серверге қосылып, аккаунтқа кіріңіз. Тапсырыс жасау бұғатталған.",
    "Avval serverga ulanib, hisobga kiring. Buyurtma yaratish bloklangan."
  ],
  "Ранее заказ был создан. Проверь список поездок перед новым заказом.": [
    "Бұрын тапсырыс жасалған. Жаңа тапсырыс алдында сапарлар тізімін тексеріңіз.",
    "Avval buyurtma yaratilgan. Yangi buyurtmadan oldin safarlar ro‘yxatini tekshiring."
  ],
  "Предыдущий заказ мог быть создан. Проверь его статус; повторное оформление заблокировано.": [
    "Алдыңғы тапсырыс жасалған болуы мүмкін. Мәртебесін тексеріңіз; қайта рәсімдеу бұғатталған.",
    "Oldingi buyurtma yaratilgan bo‘lishi mumkin. Holatini tekshiring; qayta rasmiylashtirish bloklangan."
  ],
  "Не удалось проверить предыдущие заказы на устройстве. Создание нового заказа заблокировано.": [
    "Құрылғыдағы алдыңғы тапсырыстарды тексеру мүмкін болмады. Жаңа тапсырыс жасау бұғатталған.",
    "Qurilmadagi oldingi buyurtmalarni tekshirib bo‘lmadi. Yangi buyurtma yaratish bloklangan."
  ],
  "Не удалось загрузить маршруты.": [
    "Бағыттарды жүктеу мүмкін болмады.",
    "Yo‘nalishlarni yuklab bo‘lmadi."
  ],
  "Не удалось проверить водителей.": [
    "Жүргізушілерді тексеру мүмкін болмады.",
    "Haydovchilarni tekshirib bo‘lmadi."
  ],
  "Сведения о предыдущем заказе не найдены на устройстве. Новый заказ заблокирован до проверки.": [
    "Құрылғыда алдыңғы тапсырыс деректері табылмады. Тексерілгенше жаңа тапсырыс бұғатталған.",
    "Qurilmada oldingi buyurtma maʼlumotlari topilmadi. Tekshirilguncha yangi buyurtma bloklangan."
  ],
  "Сведения о предыдущем заказе изменились. Проверь его статус ещё раз.": [
    "Алдыңғы тапсырыс деректері өзгерді. Мәртебесін қайта тексеріңіз.",
    "Oldingi buyurtma maʼlumotlari o‘zgardi. Holatini qayta tekshiring."
  ],
  "Сервер подтвердил: заказ не был создан. Можно проверить водителей снова.": [
    "Сервер растады: тапсырыс жасалмаған. Жүргізушілерді қайта тексеруге болады.",
    "Server tasdiqladi: buyurtma yaratilmagan. Haydovchilarni qayta tekshirish mumkin."
  ],
  "Заказы обновлены. Проверь состояние поездки.": [
    "Тапсырыстар жаңартылды. Сапар күйін тексеріңіз.",
    "Buyurtmalar yangilandi. Safar holatini tekshiring."
  ],
  "Проверка завершена, но конкретный заказ не подтверждён. Повторная отправка заблокирована; обратись в поддержку.": [
    "Тексеру аяқталды, бірақ нақты тапсырыс расталмады. Қайта жіберу бұғатталған; қолдауға хабарласыңыз.",
    "Tekshiruv tugadi, lekin aniq buyurtma tasdiqlanmadi. Qayta yuborish bloklangan; yordamga murojaat qiling."
  ],
  "Не удалось обновить заказы. Повтори проверку; не создавай ещё один заказ.": [
    "Тапсырыстарды жаңарту мүмкін болмады. Қайта тексеріңіз; басқа тапсырыс жасамаңыз.",
    "Buyurtmalarni yangilab bo‘lmadi. Qayta tekshiring; yana buyurtma yaratmang."
  ],
  "Заказ пока не найден. Предыдущая отправка ещё могла обрабатываться. Повтори проверку статуса; новый заказ заблокирован.": [
    "Тапсырыс әлі табылмады. Алдыңғы жіберілім өңделіп жатуы мүмкін. Мәртебені қайта тексеріңіз; жаңа тапсырыс бұғатталған.",
    "Buyurtma hali topilmadi. Oldingi yuborish hali qayta ishlanayotgan bo‘lishi mumkin. Holatni qayta tekshiring; yangi buyurtma bloklangan."
  ],
  "Не удалось проверить заказ. Повтори проверку статуса.": [
    "Тапсырысты тексеру мүмкін болмады. Мәртебесін қайта тексеріңіз.",
    "Buyurtmani tekshirib bo‘lmadi. Holatni qayta tekshiring."
  ],
  "Разреши геолокацию для проверки точки посадки.": [
    "Отыру орнын тексеру үшін геолокацияға рұқсат беріңіз.",
    "Chiqish joyini tekshirish uchun geolokatsiyaga ruxsat bering."
  ],
  "Маршрут или количество мест изменились. Проверь наличие заново.": [
    "Бағыт немесе орын саны өзгерді. Қолжетімділікті қайта тексеріңіз.",
    "Yo‘nalish yoki o‘rinlar soni o‘zgardi. Mavjudlikni qayta tekshiring."
  ],
  "Пока определяли местоположение, проверка цены и водителей устарела. Проверь наличие ещё раз.": [
    "Орналасу анықталғанша баға мен жүргізушілер тексеруі ескірді. Қолжетімділікті қайта тексеріңіз.",
    "Joylashuv aniqlanguncha narx va haydovchilar tekshiruvi eskirdi. Mavjudlikni qayta tekshiring."
  ],
  "Сервер не вернул идентификатор созданного заказа.": [
    "Сервер жасалған тапсырыс идентификаторын қайтармады.",
    "Server yaratilgan buyurtma identifikatorini qaytarmadi."
  ],
  "Заказ создан. Ожидаем подтверждения водителя.": [
    "Тапсырыс жасалды. Жүргізуші растауын күтудеміз.",
    "Buyurtma yaratildi. Haydovchi tasdig‘ini kutmoqdamiz."
  ],
  "Заказ создан, но список поездок не обновился. Проверь статус; повторно заказывать не нужно.": [
    "Тапсырыс жасалды, бірақ сапарлар тізімі жаңармады. Мәртебесін тексеріңіз; қайта тапсырыс бермеңіз.",
    "Buyurtma yaratildi, lekin safarlar ro‘yxati yangilanmadi. Holatini tekshiring; qayta buyurtma bermang."
  ],
  "Не удалось снять блокировку заказа. Повторное оформление запрещено до проверки.": [
    "Тапсырыс бұғатын алу мүмкін болмады. Тексерілгенше қайта рәсімдеуге тыйым салынады.",
    "Buyurtma blokini olib bo‘lmadi. Tekshirilguncha qayta rasmiylashtirish taqiqlangan."
  ],
  "Подходящих водителей больше нет. Заказ не создан.": [
    "Сәйкес жүргізушілер қалмады. Тапсырыс жасалмады.",
    "Mos haydovchilar qolmadi. Buyurtma yaratilmadi."
  ],
  "Маршрут изменился. Обнови список маршрутов.": [
    "Бағыт өзгерді. Бағыттар тізімін жаңартыңыз.",
    "Yo‘nalish o‘zgardi. Yo‘nalishlar ro‘yxatini yangilang."
  ],
  "Не удалось узнать, принят ли заказ сервером. Сначала обнови список поездок; повторный заказ пока заблокирован.": [
    "Сервер тапсырысты қабылдағанын анықтау мүмкін болмады. Алдымен сапарлар тізімін жаңартыңыз; қайта тапсырыс әзірге бұғатталған.",
    "Server buyurtmani qabul qilganini bilib bo‘lmadi. Avval safarlar ro‘yxatini yangilang; qayta buyurtma hozircha bloklangan."
  ],
  "Не удалось подтвердить результат предыдущей отправки. Проверь список поездок; повторное оформление заблокировано.": [
    "Алдыңғы жіберілім нәтижесін растау мүмкін болмады. Сапарлар тізімін тексеріңіз; қайта рәсімдеу бұғатталған.",
    "Oldingi yuborish natijasini tasdiqlab bo‘lmadi. Safarlar ro‘yxatini tekshiring; qayta rasmiylashtirish bloklangan."
  ],
  "Не удалось оформить заказ.": [
    "Тапсырыс рәсімдеу мүмкін болмады.",
    "Buyurtmani rasmiylashtirib bo‘lmadi."
  ],
  "Ищем водителя": [
    "Жүргізуші іздеудеміз",
    "Haydovchi qidirilmoqda"
  ],
  "Водитель едет к точке подачи": [
    "Жүргізуші келу орнына бара жатыр",
    "Haydovchi kelish joyiga bormoqda"
  ],
  "Ты в машине. Ожидаем отправления водителя": [
    "Сіз көліктесіз. Жүргізушінің шығуын күтудеміз",
    "Siz mashinadasiz. Haydovchi jo‘nashini kutmoqdamiz"
  ],
  "Поездка началась": [
    "Сапар басталды",
    "Safar boshlandi"
  ],
  "Я прибыл на точку": [
    "Келу орнына жеттім",
    "Kelish joyiga yetib keldim"
  ],
  "Начать поездку": [
    "Сапарды бастау",
    "Safarni boshlash"
  ],
  "Место посадки": [
    "Отыру орны",
    "Chiqish joyi"
  ],
  "По маршруту": [
    "Бағыт бойынша",
    "Yo‘nalish bo‘yicha"
  ]
};
export function translateOnay(text: string, language: OnayLanguage): string {
  if (language === "ru") return text;
  const key = text.trim();
  const translated = messages[key]?.[language === "kk" ? 0 : 1];
  return translated ? text.replace(key, translated) : text;
}
