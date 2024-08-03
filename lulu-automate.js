import puppeteer from 'puppeteer';
import pLimit from 'p-limit';
import { Mutex } from './mutex.js';

const LuluHyperMarketSearchPage = 'https://www.luluhypermarket.in/en-in';
const LuluHyperMarketSignInPage = 'https://www.luluhypermarket.in/en-in/login';
const LuluHyperMarketCartPage = 'https://www.luluhypermarket.in/en-in/cart'
const handleAddToCartMutex = new Mutex();

//FETCHING ITEMS
async function fetchItem(item, browser) {
  let page;
  try {
    page = await browser.newPage();
    await page.bringToFront();
    await page.goto(LuluHyperMarketSearchPage);
    await page.waitForSelector('.mobile-search-icon');
    await page.click('.mobile-search-icon');
    await page.waitForSelector('.mobileAutoCompleteSearchInput');
    await page.focus('.mobileAutoCompleteSearchInput');
    await page.type('.mobileAutoCompleteSearchInput', item);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.product-box');
    const productData = await page.$eval('.product-box', el => {
      const hiddenInput = el.querySelector('input[type="hidden"][data-name][data-price]');
      return {
        name: hiddenInput.dataset.name,
        price: hiddenInput.dataset.price,
        url: "https://www.luluhypermarket.in" + el.dataset.url
      };
    });
    return productData;
  } catch (error) {
    console.error(`An error occurred while fetching item ${item}: ${error.message}`);
  } finally {
    if (page) {
      await page.close();
    }
  }
}


async function fetchItems(items) {
    const limit = pLimit(6); // Limit to 6 concurrent browsers
  
    let browsers = [];
    try {
      // Launch browsers
      browsers = await Promise.all(items.slice(0, 6).map(() => puppeteer.launch()));      //slicing till 6 to allow max 6 browsers
      // Fetch items
      const fetchPromises = items.map((item, i) => limit(async () => {
        const browser = browsers[i % browsers.length];
        return fetchItem(item, browser);
      }));
      const results = await Promise.all(fetchPromises);
      console.log('Fetched Items');
      return results;
    } catch (error) {
      console.error(`An error occurred: ${error.message}`);
    } finally {
      await Promise.all(browsers.map(browser => browser.close()));
    }
  }
  
  async function signIn(email, password, page = null, browser = null) {
    let type = 0;
    try {
      if (browser === null && page === null) {
        type = 2;
        browser = await puppeteer.launch();
        page = await browser.newPage();
      }
      else if (browser !== null && page === null) {
        type = 1;
        page = await browser.newPage();
      }
      await page.goto(LuluHyperMarketSignInPage);
      if (page.url() == LuluHyperMarketSearchPage) //Returns true if they have already signed in
        return;
      await page.waitForSelector('#emailAddress');
      await page.focus('#emailAddress');
      await page.type('#emailAddress', email);
      await page.focus('#j_password');
      await page.type('#j_password', password);
      await Promise.all([
        page.keyboard.press('Enter'),
        page.waitForNavigation(),
      ]);
    } catch (error) {
      console.error(`An error occurred while signing in: ${error.message}`);
      if (type === 1 && page !== null) {
        await page.close(); // Close the page if it was created in this function
      }
      throw error; // Re-throw the error so it can be caught and handled by the calling code
    }
    finally {
      if (type === 1 && page !== null) {
        await page.close(); // Close the page if it was created in this function
      }
      if (type === 2 && browser !== null) {
        await browser.close();
      }
  
    }
  }
  
  
  async function handleAddToCartConfirmation(page, item, noOfTries = 0) {
    try {
      await page.waitForSelector('#addToCartButton', { timeout: 5000 });
      await page.focus('#addToCartButton');
      await page.keyboard.press('Enter');
  
      // Use Promise.race to wait for either the notification or the error message
      let result = await Promise.race([
        page.waitForSelector('.addToCart-notification', { timeout: 10000 }).then(() => 'addToCartConfirmed'),
        page.waitForSelector('.cart_popup_error_msg', { timeout: 10000 }).then(() => 'outOfStock')
      ]);
  
      if (result === 'addToCartConfirmed') {
        console.log(`Item ${item.name} added to cart`);
      } else if (result === 'outOfStock') {
        const element = await page.$('.cart_popup_error_msg');
        console.log(`Sorry, ${item.name} is running out of stock. `);
        //const elementHTML = await page.evaluate(el => el.innerHTML, element);
        //console.log(`Error message: ${elementHTML}`);
      }
      else {
        console.log(`Neither the Confirmation nor the Stock running out message appeared within 10 seconds. Retrying...`)
      }
    } catch (error) {
      // If an error occurs or neither the notification nor the error message appear within 10 seconds, retry up to 3 times
      if (noOfTries < 5) {
        console.log(`Retrying to add ${item.name} to cart`);
        await page.reload({ waitUntil: ["networkidle0", "domcontentloaded"] });
        if (page) {
          await handleAddToCartConfirmation(page, item, noOfTries + 1);
        }
      } else {
        console.log(`Failed to add ${item.name} to cart after 5 retries`);
      }
    }
  }
  
  
  
  
  async function addItemToCart(item, browser) {
    let page;
    try {
      page = await browser.newPage();
      await page.goto(item.url, { waitUntil: 'networkidle0' });
      const notAvailableButton = await page.$('.not-available-btn');
      if (notAvailableButton) {
        console.log(`Item ${item.name} is not available`);
        return;
      }
      await handleAddToCartMutex.lock();
      try {
        await handleAddToCartConfirmation(page, item);
      } finally {
        await handleAddToCartMutex.unlock();
      }
    } catch (error) {
      console.error(`An error occurred while adding ${item.name} to cart: ${error.message}`);
    } finally {
      if (page) {
        await page.close();
      }
    }
  }
  
  
  async function clearCart(email,password,noOfTries = 0) {
    const browser = await puppeteer.launch();
    let page;
    try {
      page = await browser.newPage();
      await signIn(email, password, page);
      await page.goto(LuluHyperMarketCartPage);
      let element = await page.$('#removeAllCartGroupItems');
      while (element) {
        await Promise.all([
          page.waitForNavigation(),
          page.click('#removeAllCartGroupItems')
        ])
        element = await page.$('#removeAllCartGroupItems');
      }
    } catch (error) {
      console.error(`An error occurred while clearing cart: ${error.message}`);
      if (noOfTries < 3) {
        await clearCart(email,password,noOfTries + 1);
      }
      else {
        console.log(`Failed to clear cart after 3 retries`);
      }
    } finally {
      if (page) {
        await page.close();
      }
      await browser.close();
    }
  }
  
  
  async function addFilteredItemsToCart(email,password,filteredItems) {
    const limit = pLimit(3) //limit to 3 concurrent browsers
    let browsers = [];
    try {
      let clearCartPromise = clearCart(email,password)          //Clear cart before adding items
      browsers = await Promise.all(filteredItems.slice(0, 3).map(() => puppeteer.launch()));
      await Promise.all([...browsers.map(browser => signIn(email, password, null, browser)), clearCartPromise]);
      //Add items to cart
      const addToCartPromises = filteredItems.map((filteredItem, i) => limit(async () => {
        const browser = browsers[i % browsers.length];
        return addItemToCart(filteredItem, browser);
  
      }));
      await Promise.all(addToCartPromises);
    }
    catch (error) {
      console.error(`An error occurred in processing filtered items: ${error.message}`);
    }
    finally {
      await Promise.all(browsers.map(browser => browser.close()));
    }
  
  }



async function checkout(email,password,UPI_ID) {
  const browser = await puppeteer.launch({ headless: false });
  let page;
  try {
    page = await browser.newPage();
    await signIn(email,password, page);
    await page.goto(LuluHyperMarketCartPage);
    await page.waitForSelector('#checkoutitems');
    const modalVisiblePromise = page.waitForSelector('.modal.date-time-modal.fade:not([aria-hidden="true"])', { timeout: 10000 });
    await page.click('#checkoutitems');
    try {
      try {
        await modalVisiblePromise;
      } catch (error) {
        throw new Error('modalVisiblePromise failed');
      }

      const buttonClickedPromise = page.waitForFunction(() => {
        function isVisible(element) {
          if (!element) {
            return false;
          }

          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
          }

          const rect = element.getBoundingClientRect();
          return rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
        }

        function clickFirstAvailableTime() {
          const activeRow = document.querySelector('.row.active');
          if (!activeRow) {
            console.log('No active row found');
            return false;
          }

          const availableTimeSlot = activeRow.querySelector('.available');
          if (!availableTimeSlot) {
            console.log('No available time slot found in the active row');
            return false;
          }

          availableTimeSlot.click();
          console.log('Clicked the first available time slot');
          return true;
        }

        const modal = document.getElementById('dateTimeUpdateModal');
        if (isVisible(modal)) {
          if (clickFirstAvailableTime()) {
            const updateButton = modal.querySelector('.js-updateSlotThroughForm');
            if (updateButton) {
              updateButton.click(); // click the button
              console.log('Clicked the update button');
              return true;
            }
          }
        }
        return false;
      }, {
        timeout: 30000, // Adjust timeout as needed
        polling: 'mutation' // Check for DOM mutations
      });

      await Promise.all([buttonClickedPromise, page.waitForNavigation()]);
      await page.waitForSelector('#checkoutitems');
      await page.click('#checkoutitems')
      await page.waitForNavigation()
    } catch (error) {
      if (error.message === 'modalVisiblePromise failed') {
        console.log('Navigated to payment page directly');
      }
      else {
        console.log(error);
      }
    }
    //After clicking checkoutitems and now Proceeding to payment
    await page.waitForSelector('#checkoutAddressNextBtn');
    await Promise.all([page.waitForNavigation(), page.click('#checkoutAddressNextBtn')]);
    await page.focus('#netbanking_IN');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#netbankingRazor');
    await page.click('#netbankingRazor');
    await page.waitForSelector('#redeembtn_netbanking');
    await page.click('#redeembtn_netbanking');
    await page.waitForNavigation();
    await page.waitForSelector('li[m="upi"][d="false"]');
    await page.click('li[m="upi"][d="false"]');
    await page.waitForSelector('input[name="vpa"]', { visible: true });
    await page.type('input[name="vpa"]', UPI_ID);
    await page.waitForSelector('button#pay-now', { visible: true });
    await page.click('button#pay-now');
    await new Promise(resolve => setTimeout(resolve, 60000));

  }
  catch (error) {
    console.error(`An error occurred in checkout: ${error.message}`);
    throw error;
  }
  finally {
    if (page) {
      await page.close();
    }
    await browser.close();

  }
}


////////////////////////////////////
// TESTING FUNCTIONS ///////////////            
////////////////////////////////////


async function runFetchItems() {
  async function runFetchItems() {
    const items = [
      'Milma Set Curd 400gm',
      'Happy Peanut Butter Creamy 1Kg',
      'Tomato approx. 450g-500g',
      'Grandmas Jam Mixed Fruit 1kg',
      'Britannia Cheese Block 200g',
      "Best Brown Egg 12's",
      'Modern Bread Enriched Sweet 400g',
      'Banana Njalipoovan approx.450g-500g',
      'Apple Green  approx. 450gm-500gm',
      'B Natural Orange Juice 1Litre',
      "Kellogg's All Bran Wheat Flakes Cereal 425g",
      'Eastern Hotel Coffee Powder 25gm',
      'Tata Tetley Tea 250 Tea Bags',
      'Raw Rice (White Rice) 5 KG',
      'Sunfeast Pasta Treat Masala 65g',
      'Chicken Neck 350 GM',
      'Boneless Beef Cubes Meat 1kg',
      'Pirana Fish Approximate 1.2kg',
      'Potato approx.950g-1kg',
      'Carrot approx. 450g-500g'
    ];

    results = await fetchItems(items);
    console.log(results);
    return results;
  }
}



async function runAddItemToCart() {
  const browser = await puppeteer.launch({ headless: false });
  await clearCart(email,password)
  const item = {
    name: 'Happy Peanut Butter Creamy 1Kg',
    price: '278.0',
    url: 'https://www.luluhypermarket.in/en-in/happy-peanut-butter-creamy-1kg/p/971074'
  };
  try {
    signIn(email, password, null, browser);
    await addItemToCart(item, browser);
    console.log('finished runAddItemToCart');
  } catch (error) {
    console.error(`An error occurred while adding item to cart: ${error.message}`);
  } finally {
    await browser.close();
  }
}
async function runAddFilteredItemsToCart() {
  const filteredItems = [
    {
      name: 'B Natural Orange Juice 1Litre',
      price: '126.0',
      url: 'https://www.luluhypermarket.in/en-in/b-natural-orange-juice-1litre/p/10564'
    },
    {
      name: 'Britannia Cheese Block 200g',
      price: '138.0',
      url: 'https://www.luluhypermarket.in/en-in/britannia-cheese-block-200g/p/60997'
    },
    {
      name: 'Apple Green  approx. 450gm-500gm',
      price: '140.0',
      url: 'https://www.luluhypermarket.in/en-in/p/10546_EA'
    },
    {
      name: "Best Brown Egg 12's",
      price: '189.0',
      url: 'https://www.luluhypermarket.in/en-in/best-brown-egg-12-s/p/838326'
    },
    {
      name: 'Grandmas Jam Mixed Fruit 1kg',
      price: '158.0',
      url: 'https://www.luluhypermarket.in/en-in/grandmas-jam-mixed-fruit-1kg/p/386228'
    },
    {
      name: 'Eastern Hotel Coffee Powder 25gm',
      price: '9.5',
      url: 'https://www.luluhypermarket.in/en-in/eastern-hotel-coffee-powder-25gm/p/4286'
    },
    {
      name: 'Happy Peanut Butter Creamy 1Kg',
      price: '278.0',
      url: 'https://www.luluhypermarket.in/en-in/happy-peanut-butter-creamy-1kg/p/971074'
    },
    {
      name: "Elite Bread Milk 'N' Sugar 400g",
      price: '45.0',
      url: 'https://www.luluhypermarket.in/en-in/elite-bread-milk-n-sugar-400g/p/104015'
    },
    {
      name: 'Banana Njalipoovan approx.450g-500g',
      price: '36.0',
      url: 'https://www.luluhypermarket.in/en-in/p/6270_EA'
    },
    {
      name: 'Potato approx.950g-1kg',
      price: '51.0',
      url: 'https://www.luluhypermarket.in/en-in/p/624351_EA'
    },
    {
      name: 'Sunfeast Pasta Treat Masala 65g',
      price: '27.0',
      url: 'https://www.luluhypermarket.in/en-in/sunfeast-pasta-treat-masala-65g/p/151'
    },
    {
      name: 'Pirana Fish Approximate 1.2kg',
      price: '216.0',
      url: 'https://www.luluhypermarket.in/en-in/p/62913_EA'
    },
    {
      name: 'Chicken Neck 350 GM',
      price: '65.0',
      url: 'https://www.luluhypermarket.in/en-in/p/126295_EA'
    },
    {
      name: 'Carrot approx. 450g-500g',
      price: '46.0',
      url: 'https://www.luluhypermarket.in/en-in/p/8260_EA'
    },
    {
      name: "Kellogg's All Bran Wheat Flakes Cereal 425g",
      price: '246.0',
      url: 'https://www.luluhypermarket.in/en-in/kellogg-s-all-bran-wheat-flakes-cereal-425g/p/4603'
    },
    {
      name: 'Raw Rice (White Rice) 5 KG',
      price: '215.0',
      url: 'https://www.luluhypermarket.in/en-in/p/9123_CH2'
    },
    {
      name: 'Tata Tetley Tea 250 Tea Bags',
      price: '373.0',
      url: 'https://www.luluhypermarket.in/en-in/tata-tetley-tea-250-tea-bags/p/3915'
    },
    {
      name: 'Milma Set Curd 400gm',
      price: '65.0',
      url: 'https://www.luluhypermarket.in/en-in/milma-set-curd-400gm/p/1284215'
    },
    {
      name: 'Boneless Beef Cubes Meat 1kg',
      price: '369.0',
      url: 'https://www.luluhypermarket.in/en-in/p/93466_EA'
    },
    {
      name: 'Tomato approx. 450g-500g',
      price: '45.0',
      url: 'https://www.luluhypermarket.in/en-in/p/7649_EA'
    }
  ];
  try {
    await addFilteredItemsToCart(filteredItems);
    console.log('Items added to cart successfully');
  } catch (error) {
    console.error(`An error occurred while adding items to cart: ${error.message}`);
  }
}




// Call the test function

//fetchItems();
//runAddItemToCart();
//runAddFilteredItemsToCart();
//clearCart();
//checkout(process.env.UPI_ID);
//handleDateAndTimeUpdateModal();
//signIn(process.env.USER_EMAIL, process.env.USER_PASSWORD);



  
